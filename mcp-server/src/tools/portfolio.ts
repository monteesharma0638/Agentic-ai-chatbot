import { z } from 'zod';
import { xirr, type CashFlow } from '../analytics/investments.js';
import { mapWithConcurrency } from '../lib/cache.js';
import { isoToDay, parseDateArg } from '../lib/dates.js';
import { formatInr, pct, round } from '../lib/format.js';
import { assetClass, dateArg, READ_ONLY, run, schemeCodeArg, type ToolDeps } from './common.js';

const holdingSchema = z.object({
  scheme_code: schemeCodeArg,
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
});

export function registerPortfolioTools({ server, repo }: ToolDeps): void {
  server.registerTool(
    'analyze_portfolio',
    {
      title: 'Analyze portfolio',
      description:
        "Value a set of mutual fund holdings at the latest NAV: per-fund value, gain, weight, and portfolio totals, allocation by asset class, " +
        'category and AMC, plus XIRR when transactions are provided.',
      inputSchema: {
        holdings: z.array(holdingSchema).min(1).max(60),
      },
      annotations: READ_ONLY,
    },
    async ({ holdings }) =>
      run(async () => {
        const dir = await repo.directory.get().catch(() => null);
        const rows = await mapWithConcurrency(holdings, 6, async (h) => {
          const record = dir?.byCode.get(h.scheme_code);
          let name = record?.name;
          let category = record?.category ?? 'Unknown';
          let fundHouse = record?.fundHouse ?? 'Unknown';
          let nav = record?.nav ?? null;
          let navDate = record?.navDate ?? null;
          if (nav === null || navDate === null) {
            const fund = await repo.getFund(h.scheme_code);
            ({ name, category, fundHouse } = fund);
            ({ nav, date: navDate } = fund.series.last());
          }
          const value = h.units * nav;
          const flows: CashFlow[] = (h.transactions ?? []).map((t) => ({
            day: isoToDay(parseDateArg(t.date)),
            amount: -t.amount,
          }));
          const invested =
            h.invested_amount ?? (h.transactions ? h.transactions.reduce((s, t) => s + t.amount, 0) : undefined);
          return {
            scheme_code: h.scheme_code,
            scheme_name: name ?? `Scheme ${h.scheme_code}`,
            category,
            asset_class: assetClass(category, name),
            fund_house: fundHouse,
            units: h.units,
            nav,
            nav_date: navDate,
            value,
            invested,
            flows,
            valueDay: isoToDay(navDate),
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
              scheme_code: r.scheme_code,
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
            };
          });

        const top = holdingsOut[0];
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
