import { z } from 'zod';
import { projectCorpus, simulateLumpsum, simulateSip } from '../analytics/investments.js';
import { rollingReturns } from '../analytics/returns.js';
import { parseDateArg, yearsBetween } from '../lib/dates.js';
import { formatInr, pct, round } from '../lib/format.js';
import { assetClass, dateArg, fundArgs, fundHeader, loadFund, READ_ONLY, run, type ToolDeps } from './common.js';

const COSTS_NOTE = 'Excludes stamp duty (0.005%), exit load and taxes.';

/** Long-run return assumptions (conservative / base / optimistic) when history is too short. */
const ASSUMPTIONS: Record<string, [number, number, number]> = {
  Equity: [0.08, 0.11, 0.14],
  Hybrid: [0.07, 0.09, 0.11],
  Debt: [0.055, 0.065, 0.075],
  Commodities: [0.05, 0.08, 0.11],
  International: [0.06, 0.1, 0.13],
  'Fund of Funds': [0.07, 0.09, 0.12],
  Other: [0.06, 0.09, 0.12],
};

export function registerCalculatorTools({ server, repo }: ToolDeps): void {
  server.registerTool(
    'calculate_lumpsum_returns',
    {
      title: 'Lumpsum back-test',
      description:
        'What a one-time investment in a scheme on a past date would be worth today (or on end_date): units, value, gain, absolute return and CAGR.',
      inputSchema: {
        ...fundArgs,
        amount: z.number().positive().describe('Amount invested in INR'),
        start_date: dateArg('Investment date'),
        end_date: dateArg('Valuation date (default latest NAV)').optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const fund = await loadFund(repo, args);
        const start = parseDateArg(args.start_date, 'start_date');
        const end = args.end_date ? parseDateArg(args.end_date, 'end_date') : undefined;
        const r = simulateLumpsum(fund.series, args.amount, start, end);
        return {
          ...fundHeader(fund),
          amount_invested: args.amount,
          invest_date: r.investDate,
          invest_nav: r.investNav,
          units: round(r.units, 3),
          valuation_date: r.valuationDate,
          valuation_nav: r.valuationNav,
          current_value: round(r.value),
          current_value_inr: formatInr(r.value),
          gain: round(r.value - args.amount),
          absolute_return_pct: pct(r.absolute),
          cagr_pct: pct(r.annualised),
          notes: [
            ...(r.startAdjusted ? [`Fund launched later; investment assumed on first NAV date ${r.investDate}.`] : []),
            COSTS_NOTE,
          ],
        };
      }),
  );

  server.registerTool(
    'calculate_sip_returns',
    {
      title: 'SIP back-test',
      description:
        'Back-test a monthly SIP in a scheme between two dates using actual historical NAVs: instalments, total invested, ' +
        'current value, gain, XIRR and yearly snapshots. Supports annual step-up.',
      inputSchema: {
        ...fundArgs,
        monthly_amount: z.number().positive().describe('Monthly SIP amount in INR'),
        start_date: dateArg('First SIP date'),
        end_date: dateArg('Stop SIP and value on this date (default latest NAV)').optional(),
        sip_day: z.number().int().min(1).max(31).optional().describe('Day of month for instalments (default: day of start_date)'),
        annual_step_up_pct: z.number().min(0).max(100).optional().describe('Increase the SIP by this % every year'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const fund = await loadFund(repo, args);
        const r = simulateSip(fund.series, {
          monthlyAmount: args.monthly_amount,
          startIso: parseDateArg(args.start_date, 'start_date'),
          endIso: args.end_date ? parseDateArg(args.end_date, 'end_date') : undefined,
          sipDay: args.sip_day,
          stepUpPct: args.annual_step_up_pct,
        });
        return {
          ...fundHeader(fund),
          monthly_amount: args.monthly_amount,
          annual_step_up_pct: args.annual_step_up_pct ?? 0,
          first_instalment: r.firstInstalment,
          last_instalment: r.lastInstalment,
          instalments: r.instalments,
          total_invested: round(r.invested),
          total_invested_inr: formatInr(r.invested),
          units: round(r.units, 3),
          valuation_date: r.valuationDate,
          valuation_nav: r.valuationNav,
          current_value: round(r.value),
          current_value_inr: formatInr(r.value),
          gain: round(r.value - r.invested),
          absolute_return_pct: pct(r.absolute),
          xirr_pct: pct(r.xirr),
          yearly_snapshots: r.snapshots.map((x) => ({
            date: x.date,
            instalments: x.instalments,
            invested: round(x.invested, 0),
            value: round(x.value, 0),
          })),
          notes: [
            ...(r.startAdjusted ? [`Fund launched later; SIP assumed to start on ${r.firstInstalment}.`] : []),
            'Instalments use the NAV of the SIP date or the next business day.',
            COSTS_NOTE,
          ],
        };
      }),
  );

  server.registerTool(
    'estimate_future_value',
    {
      title: 'Future value estimate',
      description:
        'Scenario-based estimate of a future investment value (lumpsum and/or monthly SIP) and of the future NAV of a scheme. ' +
        "When scheme_code is given, scenarios come from the fund's own historical rolling returns (10th/50th/90th percentile); " +
        'otherwise from long-run category assumptions or expected_return_pct. This is a statistical estimate, NOT a prediction.',
      inputSchema: {
        years: z.number().min(0.5).max(40).describe('Investment horizon in years'),
        ...fundArgs,
        lumpsum_amount: z.number().min(0).optional().describe('One-time amount invested today (INR)'),
        monthly_sip: z.number().min(0).optional().describe('Monthly SIP amount (INR)'),
        annual_step_up_pct: z.number().min(0).max(100).optional().describe('Yearly SIP increase %'),
        expected_return_pct: z.number().min(-20).max(40).optional().describe('Use this annual return instead of history'),
        asset_class: z
          .enum(['Equity', 'Hybrid', 'Debt', 'Commodities', 'International', 'Other'])
          .optional()
          .describe('Used for default assumptions when no scheme_code/expected_return_pct'),
        inflation_pct: z.number().min(0).max(15).optional().describe('Inflation for real-value figures (default 6)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const inflation = args.inflation_pct ?? 6;
        const lumpsum = args.lumpsum_amount ?? 0;
        const sip = args.monthly_sip ?? 0;
        let basis: string;
        let rates: { name: string; rate: number }[];
        let latestNav: { date: string; nav: number } | null = null;
        let header: object = {};
        const warnings: string[] = [];

        if (args.expected_return_pct !== undefined) {
          basis = `User-supplied expected return of ${args.expected_return_pct}% p.a.`;
          rates = [{ name: 'expected', rate: args.expected_return_pct / 100 }];
        } else if (args.scheme_code || args.fund) {
          const fund = await loadFund(repo, args);
          header = fundHeader(fund);
          latestNav = fund.series.last();
          const historyYears = yearsBetween(fund.series.firstDay, fund.series.lastDay);
          // Longest rolling window that still leaves a meaningful number of observations.
          const target = Math.min(Math.max(1, Math.round(args.years)), 10);
          let dist = null;
          let window = target;
          for (; window >= 1; window--) {
            if (historyYears < window + 0.5) continue;
            dist = rollingReturns(fund.series, window);
            if (dist && dist.observations >= 120) break;
            dist = null;
          }
          if (dist) {
            basis = `${window}-year rolling returns of this fund (${dist.observations} observations since ${fund.series.first().date})`;
            rates = [
              { name: 'conservative (10th percentile)', rate: dist.p10 },
              { name: 'base (median)', rate: dist.median },
              { name: 'optimistic (90th percentile)', rate: dist.p90 },
            ];
            if (window < target) warnings.push(`Only ${window}-year windows available; longer-horizon outcomes are less certain.`);
            if (dist.median > 0.2) warnings.push('Historical median above 20% p.a. rarely persists; treat the base case with caution.');
          } else {
            const cls = assetClass(fund.category, fund.name);
            basis = `Fund history too short; long-run ${cls} assumptions`;
            rates = ASSUMPTIONS[cls].map((rate, i) => ({ name: ['conservative', 'base', 'optimistic'][i], rate }));
          }
        } else {
          const cls = args.asset_class ?? 'Equity';
          basis = `Long-run ${cls} assumptions`;
          rates = ASSUMPTIONS[cls].map((rate, i) => ({ name: ['conservative', 'base', 'optimistic'][i], rate }));
        }

        const scenarios = rates.map(({ name, rate }) => {
          const p = projectCorpus({
            lumpsum,
            monthlySip: sip,
            years: args.years,
            annualReturn: rate,
            stepUpPct: args.annual_step_up_pct,
            inflationPct: inflation,
          });
          return {
            scenario: name,
            annual_return_pct: pct(rate),
            ...(latestNav && { projected_nav: round(latestNav.nav * (1 + rate) ** args.years) }),
            ...((lumpsum > 0 || sip > 0) && {
              total_invested: round(p.invested, 0),
              future_value: round(p.futureValue, 0),
              future_value_inr: formatInr(p.futureValue),
              gain: round(p.gain, 0),
              value_in_todays_rupees: p.realValue === null ? null : round(p.realValue, 0),
            }),
          };
        });

        return {
          ...header,
          horizon_years: args.years,
          ...(latestNav && { latest_nav: latestNav }),
          basis,
          inflation_pct: inflation,
          scenarios,
          warnings,
          disclaimer:
            'Illustrative projection from historical data/assumptions. Mutual fund returns are not guaranteed; past performance does not indicate future results.',
        };
      }),
  );
}
