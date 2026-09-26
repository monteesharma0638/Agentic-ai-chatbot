import { z } from 'zod';
import { pointToPoint, rollingReturns, trailingReturns } from '../analytics/returns.js';
import { riskMetrics, type RiskResult } from '../analytics/risk.js';
import { config } from '../config.js';
import type { SchemeRecord } from '../data/amfi.js';
import type { Fund } from '../data/repository.js';
import { matchesFilters, normalizeText } from '../data/search.js';
import { mapWithConcurrency, TtlCache } from '../lib/cache.js';
import { addYears, dayToIso, isoToDay } from '../lib/dates.js';
import { pct, round } from '../lib/format.js';
import { fundArgs, fundHeader, loadFund, READ_ONLY, run, schemeCodeArg, type ToolDeps } from './common.js';

function riskView(r: RiskResult | null) {
  if (!r) return null;
  return {
    period: { from: r.from, to: r.to },
    annualised_return_pct: pct(r.annualisedReturn),
    volatility_pct: pct(r.volatility),
    sharpe: r.sharpe === null ? null : round(r.sharpe),
    sortino: r.sortino === null ? null : round(r.sortino),
    max_drawdown: {
      pct: pct(r.maxDrawdown.depth),
      peak_date: r.maxDrawdown.peakDate,
      trough_date: r.maxDrawdown.troughDate,
      recovered_on: r.maxDrawdown.recoveryDate,
    },
    best_day: { date: r.bestDay.date, return_pct: pct(r.bestDay.return) },
    worst_day: { date: r.worstDay.date, return_pct: pct(r.worstDay.return) },
    positive_days_pct: pct(r.positiveDaysShare),
    ...(r.benchmark && {
      vs_benchmark: {
        beta: round(r.benchmark.beta),
        alpha_pct: pct(r.benchmark.alpha),
        correlation: round(r.benchmark.correlation),
        benchmark_return_pct: pct(r.benchmark.benchmarkReturn),
      },
    }),
  };
}

function lastYears(fund: Fund, years: number) {
  const s = fund.series;
  return s.slice(isoToDay(addYears(s.last().date, -years)), s.lastDay);
}

const rankCache = new TtlCache<unknown>(100, 3 * 60 * 60_000);

export function registerAnalysisTools({ server, repo }: ToolDeps): void {
  server.registerTool(
    'get_rolling_returns',
    {
      title: 'Rolling returns',
      description:
        'Rolling-return distribution: for every day in history, the return an investor would have earned over the previous N years. ' +
        'Shows consistency (median, min/max, 10th/90th percentile, % of periods negative or above 8/10/12/15%). Better than point-to-point returns for judging a fund.',
      inputSchema: {
        ...fundArgs,
        window_years: z.number().min(0.25).max(15).optional().describe('Holding period in years (default 3)'),
        lookback_years: z.number().min(1).max(30).optional().describe('Only consider windows ending in the last N years'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const fund = await loadFund(repo, args);
        const window = args.window_years ?? 3;
        const d = rollingReturns(fund.series, window, args.lookback_years);
        if (!d) {
          throw new Error(
            `Not enough history for ${window}-year rolling returns (data from ${fund.series.first().date}). Try a shorter window.`,
          );
        }
        return {
          ...fundHeader(fund),
          window_years: window,
          return_type: window >= 1 ? 'CAGR' : 'absolute',
          observations: d.observations,
          mean_pct: pct(d.mean),
          median_pct: pct(d.median),
          min: { return_pct: pct(d.min.value), window_ending: d.min.end_date },
          max: { return_pct: pct(d.max.value), window_ending: d.max.end_date },
          p10_pct: pct(d.p10),
          p25_pct: pct(d.p25),
          p75_pct: pct(d.p75),
          p90_pct: pct(d.p90),
          negative_periods_pct: pct(d.negativeShare),
          periods_above_pct: Object.fromEntries(Object.entries(d.above).map(([k, v]) => [k, pct(v)])),
        };
      }),
  );

  server.registerTool(
    'get_risk_metrics',
    {
      title: 'Risk metrics',
      description:
        'Risk statistics over the last N years: annualised return, volatility (std dev), Sharpe, Sortino, maximum drawdown ' +
        '(with peak/trough/recovery dates), best/worst day, and beta/alpha/correlation vs a benchmark (default: Nifty 50 index fund).',
      inputSchema: {
        ...fundArgs,
        period_years: z.number().min(0.5).max(20).optional().describe('Look-back period in years (default 3)'),
        benchmark_scheme_code: schemeCodeArg
          .optional()
          .describe('Scheme code of an index fund to use as benchmark (default UTI Nifty 50 Index Fund, 120716)'),
        risk_free_rate_pct: z.number().min(0).max(15).optional().describe(`Annual risk-free rate % (default ${config.riskFreeRatePct})`),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const years = args.period_years ?? 3;
        const benchCode = args.benchmark_scheme_code ?? config.benchmarkSchemeCode;
        const [fund, benchFund] = await Promise.all([loadFund(repo, args), repo.getFund(benchCode).catch(() => null)]);
        const bench = benchFund && benchFund.code !== fund.code ? benchFund : null; // no self-benchmark
        const window = lastYears(fund, years);
        const r = riskMetrics(window, (args.risk_free_rate_pct ?? config.riskFreeRatePct) / 100, bench?.series);
        if (!r) throw new Error(`Not enough NAV history in the last ${years} years to compute risk metrics.`);
        return {
          ...fundHeader(fund),
          ...(bench && { benchmark: { scheme_code: bench.code, scheme_name: bench.name } }),
          risk_free_rate_pct: args.risk_free_rate_pct ?? config.riskFreeRatePct,
          ...riskView(r),
          notes: [
            ...(isoToDay(r.from) > isoToDay(addYears(fund.series.last().date, -years)) + 7
              ? [`Fund history is shorter than ${years} years; metrics cover ${r.from} onwards.`]
              : []),
            'Volatility is annualised from daily returns. Sharpe/Sortino use the annualised return minus the risk-free rate.',
          ],
        };
      }),
  );

  server.registerTool(
    'compare_funds',
    {
      title: 'Compare funds',
      description:
        'Side-by-side comparison of 2–6 schemes: category, latest NAV, trailing returns (1Y/3Y/5Y/since inception), ' +
        'risk over the period (volatility, max drawdown, Sharpe), 3-year rolling-return consistency, and growth of ₹10,000 over the common period.',
      inputSchema: {
        scheme_codes: z.array(schemeCodeArg).max(6).optional().describe('Scheme codes to compare'),
        funds: z
          .array(z.string().min(2))
          .max(6)
          .optional()
          .describe('Fund names to compare instead of (or in addition to) scheme_codes; Direct-Growth is chosen'),
        period_years: z.number().min(1).max(15).optional().describe('Period for risk and growth-of-10k (default 3)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const years = args.period_years ?? 3;
        const byName = await Promise.all((args.funds ?? []).map((name) => loadFund(repo, { fund: name })));
        const byCode = await Promise.all((args.scheme_codes ?? []).map((c) => repo.getFund(c)));
        const funds = [...byCode, ...byName];
        if (funds.length < 2 || funds.length > 6) throw new Error('Compare between 2 and 6 funds (scheme_codes and/or funds).');
        const commonEnd = Math.min(...funds.map((f) => f.series.lastDay));
        const periodStart = isoToDay(addYears(funds[0].series.last().date, -years));
        const commonStart = Math.max(periodStart, ...funds.map((f) => f.series.firstDay));

        const rows = funds.map((fund) => {
          const t = trailingReturns(fund.series);
          const growth = fund.series.slice(commonStart, commonEnd);
          const rolling = rollingReturns(fund.series, 3);
          const r = riskMetrics(lastYears(fund, years), config.riskFreeRatePct / 100);
          return {
            ...fundHeader(fund),
            plan: fund.plan,
            latest_nav: fund.series.last(),
            inception: fund.series.first().date,
            returns_pct: {
              '1Y': t['1Y'] ? pct(t['1Y'].absolute) : null,
              '3Y_cagr': t['3Y'] ? pct(t['3Y'].annualised) : null,
              '5Y_cagr': t['5Y'] ? pct(t['5Y'].annualised) : null,
              since_inception_cagr: t.SI ? pct(t.SI.annualised ?? t.SI.absolute) : null,
            },
            risk: r && {
              volatility_pct: pct(r.volatility),
              max_drawdown_pct: pct(r.maxDrawdown.depth),
              sharpe: r.sharpe === null ? null : round(r.sharpe),
            },
            rolling_3y: rolling && {
              median_pct: pct(rolling.median),
              min_pct: pct(rolling.min.value),
              negative_periods_pct: pct(rolling.negativeShare),
            },
            growth_of_10000: growth.length > 1 ? round((10000 * growth.last().nav) / growth.first().nav, 0) : null,
          };
        });
        
        return {
          risk_period_years: years,
          growth_period: { from: dayToIso(commonStart), to: dayToIso(commonEnd) },
          funds: rows,
          notes: [
            'Compare funds of the same category and plan (Direct vs Regular differ by expense ratio).',
            ...(commonStart > periodStart ? ['Growth period shortened to when all funds have data.'] : []),
          ],
        };
      }),
  );

  server.registerTool(
    'rank_funds_in_category',
    {
      title: 'Rank funds in a category',
      description:
        "Rank all active schemes in a category (e.g. 'small cap', 'large cap', 'flexi cap', 'elss', 'liquid') by trailing return, " +
        'Sharpe, volatility or max drawdown over 1/3/5/10 years. Defaults to Direct-Growth plans. Answers "top/best performing X funds". ' +
        'Past performance only — not a recommendation. Can take several seconds for large categories.',
      inputSchema: {
        category: z.string().describe("Category keywords, e.g. 'small cap', 'large & mid cap', 'elss', 'index'"),
        period: z.enum(['1Y', '3Y', '5Y', '10Y']).optional().describe('Look-back period (default 3Y)'),
        sort_by: z
          .enum(['return', 'sharpe', 'volatility', 'max_drawdown'])
          .optional()
          .describe('Ranking metric (default return; volatility/max_drawdown rank lowest risk first)'),
        plan: z.enum(['direct', 'regular']).optional().describe('Default direct'),
        name_contains: z.string().optional().describe("Extra name filter, e.g. 'nifty 50' within index funds"),
        fund_house: z.string().optional(),
        limit: z.number().int().min(1).max(25).optional().describe('Number of funds to return (default 10)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const period = args.period ?? '3Y';
        const sortBy = args.sort_by ?? 'return';
        const cacheKey = JSON.stringify({ ...args, period, sortBy, limit: undefined });
        const limit = args.limit ?? 10;

        const computed = (await rankCache.getOrLoad(cacheKey, async () => {
          const dir = await repo.directory.get();
          const nameFilter = args.name_contains ? normalizeText(args.name_contains) : null;
          const freshest = Math.max(...dir.schemes.map((s) => (s.navDate ? isoToDay(s.navDate) : 0)));
          const candidates = dir.schemes.filter(
            (s: SchemeRecord) =>
              matchesFilters(s, {
                category: args.category,
                plan: args.plan ?? 'direct',
                option: 'growth',
                fundHouse: args.fund_house,
                openEndedOnly: true,
              }) &&
              s.navDate !== null &&
              freshest - isoToDay(s.navDate) <= 10 &&
              (!nameFilter || normalizeText(s.name).includes(nameFilter)),
          );
          if (candidates.length === 0) {
            throw new Error(`No active schemes match category "${args.category}". Use list_categories to see valid categories.`);
          }
          if (candidates.length > config.rankMaxSchemes) {
            throw new Error(
              `${candidates.length} schemes match "${args.category}" — too many to rank at once. ` +
                'Narrow it with a more specific category, name_contains (e.g. "nifty 50") or fund_house.',
            );
          }
          const years = Number(period.replace('Y', ''));
          const results = await mapWithConcurrency(candidates, 8, async (s) => {
            try {
              const fund = await repo.getFund(s.code);
              const start = addYears(fund.series.last().date, -years);
              if (isoToDay(start) < fund.series.firstDay) return { skipped: s.name };
              const ret = pointToPoint(fund.series, start);
              const risk = riskMetrics(lastYears(fund, years), config.riskFreeRatePct / 100);
              return {
                scheme_code: fund.code,
                scheme_name: fund.name,
                fund_house: fund.fundHouse,
                return_pct: ret ? pct(ret.annualised ?? ret.absolute) : null,
                sharpe: risk?.sharpe == null ? null : round(risk.sharpe),
                volatility_pct: risk ? pct(risk.volatility) : null,
                max_drawdown_pct: risk ? pct(risk.maxDrawdown.depth) : null,
                latest_nav: fund.series.last(),
              };
            } catch {
              return { skipped: s.name };
            }
          });
          const ranked = results.filter((r): r is Exclude<typeof r, { skipped: string }> => !('skipped' in r));
          return {
            ranked,
            skipped: results.length - ranked.length,
            considered: candidates.length,
            categories: [...new Set(candidates.map((c) => c.category))],
          };
        })) as {
          ranked: { return_pct: number | null; sharpe: number | null; volatility_pct: number | null; max_drawdown_pct: number | null }[];
          skipped: number;
          considered: number;
          categories: string[];
        };

        const key = { return: 'return_pct', sharpe: 'sharpe', volatility: 'volatility_pct', max_drawdown: 'max_drawdown_pct' }[
          sortBy
        ] as 'return_pct' | 'sharpe' | 'volatility_pct' | 'max_drawdown_pct';
        // Higher is better for return/sharpe/max_drawdown (less negative); lower is better for volatility.
        const dir = sortBy === 'volatility' ? 1 : -1;
        const sorted = [...computed.ranked]
          .filter((r) => r[key] !== null)
          .sort((a, b) => dir * ((a[key] as number) - (b[key] as number)));

        return {
          categories_matched: computed.categories,
          period,
          sort_by: sortBy,
          return_type: period === '1Y' ? 'absolute' : 'CAGR',
          schemes_considered: computed.considered,
          excluded_insufficient_history: computed.skipped,
          top: sorted.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })),
          notes: [
            'Direct-Growth plans unless specified. Only currently active schemes are included (survivorship bias).',
            'Ranking reflects past performance only and is not investment advice.',
          ],
        };
      }),
  );
}
