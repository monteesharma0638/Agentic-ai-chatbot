import { z } from 'zod';
import { xirr, type CashFlow } from '../analytics/investments.js';
import { mapWithConcurrency } from '../lib/cache.js';
import { isoToDay, parseDateArg } from '../lib/dates.js';
import { formatInr, pct, round } from '../lib/format.js';
import { assetClass, dateArg, READ_ONLY, run, schemeCodeArg, type ToolDeps } from './common.js';

const holdingSchema = z
  .object({
    scheme_code: schemeCodeArg.optional(),
    isin: z
      .string()
      .trim()
      .regex(/^INF[A-Z0-9]{9}$/i, 'ISIN like INF179K01BE2')
      .optional()
      .describe('ISIN of the holding; resolved to its AMFI scheme (and live NAV) when scheme_code is not given'),
    units: z.number().positive().describe('Units currently held'),
    invested_amount: z.number().min(0).optional().describe('Net amount invested (cost) in INR'),
    transactions: z
      .array(
        z.object({
          date: dateArg('Transaction date'),
          amount: z.number().describe('INR; positive = purchase/SIP, negative = redemption'),
        }),
      )
      .max(600)
      .optional()
      .describe('Optional cash-flow history, enables XIRR'),
    // Fallbacks used only when neither scheme_code nor isin resolves to an AMFI scheme
    // (e.g. a closed/merged scheme). They let a holding still be counted rather than dropped.
    scheme_name: z.string().max(200).optional().describe('Display name, used only if the scheme cannot be resolved'),
    asset_class: z.string().max(40).optional().describe('Equity / Debt / Cash etc., used only if the scheme cannot be resolved'),
    current_value: z.number().min(0).optional().describe('Pre-computed current value in INR, used only if the scheme cannot be resolved'),
    nav: z.number().positive().optional().describe("The source's NAV, used only if the scheme cannot be resolved"),
    nav_date: z.string().optional().describe("Date of the source's NAV (YYYY-MM-DD), used only if the scheme cannot be resolved"),
  })
  .refine((h) => h.scheme_code !== undefined || h.isin !== undefined || h.current_value !== undefined, {
    message: 'Each holding needs a scheme_code, an isin, or a current_value to be valued.',
  });

export function registerPortfolioTools({ server, repo }: ToolDeps): void {
  server.registerTool(
    'analyze_portfolio',
    {
      title: 'Analyze portfolio',
      description:
        'Value a set of mutual fund holdings at the latest NAV: per-fund value, gain, weight, and portfolio totals, allocation by asset class, ' +
        'category and AMC, plus XIRR when transactions are provided. Each holding is identified by its scheme_code or its ISIN; a holding whose ' +
        'ISIN is not in the AMFI list falls back to the current_value/asset_class supplied for it.',
      inputSchema: {
        holdings: z.array(holdingSchema).min(1).max(60),
      },
      annotations: READ_ONLY,
    },
    async ({ holdings }) =>
      run(async () => {
        const dir = await repo.directory.get().catch(() => null);
        const rows = await mapWithConcurrency(holdings, 6, async (h) => {
          // Prefer an explicit scheme code, else resolve the ISIN to an AMFI scheme.
          const code = h.scheme_code ?? (h.isin ? dir?.byIsin.get(h.isin.toUpperCase())?.code : undefined);
          let name: string | undefined;
          let category = 'Unknown';
          let fundHouse = 'Unknown';
          let nav: number | null = null;
          let navDate: string | null = null;
          let value: number;
          let priced: 'live' | 'source';

          if (code !== undefined) {
            const record = dir?.byCode.get(code);
            name = record?.name;
            category = record?.category ?? 'Unknown';
            fundHouse = record?.fundHouse ?? 'Unknown';
            nav = record?.nav ?? null;
            navDate = record?.navDate ?? null;
            if (nav === null || navDate === null) {
              const fund = await repo.getFund(code);
              ({ name, category, fundHouse } = fund);
              ({ nav, date: navDate } = fund.series.last());
            }
            value = h.units * nav;
            priced = 'live';
          } else {
            // Couldn't match to AMFI: value from the figures the caller supplied for this holding.
            name = h.scheme_name;
            nav = h.nav ?? null;
            navDate = h.nav_date ?? null;
            value = h.current_value ?? (nav !== null ? h.units * nav : 0);
            category = h.asset_class ?? 'Unknown';
            fundHouse = 'Unknown';
            priced = 'source';
          }

          const flows: CashFlow[] = (h.transactions ?? []).map((t) => ({
            day: isoToDay(parseDateArg(t.date)),
            amount: -t.amount,
          }));
          const invested =
            h.invested_amount ?? (h.transactions ? h.transactions.reduce((s, t) => s + t.amount, 0) : undefined);
          return {
            scheme_code: code,
            scheme_name: name ?? (h.scheme_name || (h.isin ? `ISIN ${h.isin}` : 'Unknown fund')),
            category,
            asset_class: priced === 'live' ? assetClass(category, name) : h.asset_class ?? assetClass(category, name ?? ''),
            fund_house: fundHouse,
            units: h.units,
            nav,
            nav_date: navDate,
            value,
            invested,
            flows,
            priced,
            valueDay: navDate ? isoToDay(navDate) : isoToDay(new Date().toISOString().slice(0, 10)),
          };
        });

        const total = rows.reduce((s, r) => s + r.value, 0);
        const withCost = rows.filter((r) => r.invested !== undefined);
        const totalInvested = withCost.reduce((s, r) => s + (r.invested ?? 0), 0);
        const valueWithCost = withCost.reduce((s, r) => s + r.value, 0);
        const group = (key: 'asset_class' | 'category' | 'fund_house') => {
          const m = new Map<string, number>();
          for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + r.value);
          return [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, v]) => ({ name, value: round(v, 0), weight_pct: pct(v / total) }));
        };

        const allFlows: CashFlow[] = [];
        const everyHoldingHasFlows = rows.every((r) => r.flows.length > 0);
        const holdingsOut = rows
          .sort((a, b) => b.value - a.value)
          .map((r) => {
            const holdingXirr = r.flows.length ? xirr([...r.flows, { day: r.valueDay, amount: r.value }]) : null;
            if (everyHoldingHasFlows) allFlows.push(...r.flows, { day: r.valueDay, amount: r.value });
            return {
              ...(r.scheme_code !== undefined && { scheme_code: r.scheme_code }),
              scheme_name: r.scheme_name,
              category: r.category,
              units: r.units,
              nav: r.nav,
              nav_date: r.nav_date,
              current_value: round(r.value),
              weight_pct: pct(r.value / total),
              ...(r.invested !== undefined && {
                invested: round(r.invested),
                gain: round(r.value - r.invested),
                gain_pct: r.invested > 0 ? pct(r.value / r.invested - 1) : null,
              }),
              ...(holdingXirr !== null && { xirr_pct: pct(holdingXirr) }),
              ...(r.priced === 'source' && { valued_from: "the app's own data (not live NAV)" }),
            };
          });

        const top = holdingsOut[0];
        const fromSource = rows.filter((r) => r.priced === 'source').length;
        return {
          total_value: round(total),
          total_value_inr: formatInr(total),
          ...(withCost.length > 0 && {
            total_invested: round(totalInvested),
            total_gain: round(valueWithCost - totalInvested),
            total_gain_pct: totalInvested > 0 ? pct(valueWithCost / totalInvested - 1) : null,
            ...(withCost.length < rows.length && { note: 'Totals for invested/gain exclude holdings without cost data.' }),
          }),
          ...(everyHoldingHasFlows && { portfolio_xirr_pct: pct(xirr(allFlows)) }),
          ...(fromSource > 0 && {
            valuation_note: `${fromSource} of ${rows.length} holding(s) could not be matched to the AMFI list and were valued from the app's own figures.`,
          }),
          holdings_count: rows.length,
          largest_holding: { scheme_name: top.scheme_name, weight_pct: top.weight_pct },
          allocation: {
            by_asset_class: group('asset_class'),
            by_category: group('category'),
            by_fund_house: group('fund_house'),
          },
          holdings: holdingsOut,
        };
      }),
  );
}
