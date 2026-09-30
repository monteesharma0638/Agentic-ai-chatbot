import type { BarChart, Chart, DonutChart } from './types.js';

/** Plain-language progress labels shown in the chat UI while a tool runs (most users are not finance experts). */
const LABELS: Record<string, string> = {
  search_funds: 'Finding the right fund',
  list_categories: 'Looking up fund types',
  list_fund_houses: 'Looking up fund companies',
  get_fund_overview: 'Getting the fund details',
  get_nav_history: "Checking the fund's price history",
  get_nav_on_date: "Checking the fund's price on that date",
  calculate_lumpsum_returns: 'Working out how your money grew',
  calculate_sip_returns: 'Working out how your SIP grew',
  estimate_future_value: 'Estimating how your money could grow',
  get_rolling_returns: 'Checking how steady the returns have been',
  get_risk_metrics: 'Checking the ups and downs',
  compare_funds: 'Comparing the funds',
  rank_funds_in_category: 'Finding the top performers',
  analyze_portfolio: 'Going through your investments',
  get_my_portfolio: 'Going through your investments',
};

export function toolLabel(name: string): string {
  return LABELS[name] ?? 'Looking that up';
}

type Json = Record<string, unknown>;

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 2020-03-23 → 23 Mar 2020 */
function longDate(iso: unknown): string {
  const d = new Date(`${String(iso)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** ₹84,862 / ₹2.38 lakh / ₹1.2 crore */
function rupees(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${+(v / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `₹${+(v / 1e5).toFixed(2)} lakh`;
  return `₹${inr.format(v)}`;
}

/** Short forms that stay in capitals when an all-caps AMFI name is re-cased. */
const ACRONYMS = new Set(['SBI', 'UTI', 'HDFC', 'ICICI', 'DSP', 'IDFC', 'LIC', 'HSBC', 'PGIM', 'ITI', 'JM', 'ETF', 'FOF', 'ELSS', 'PSU', 'US', 'IT', 'ESG', 'BSE', 'NSE', 'S&P']);

/** "HDFC Mid Cap Fund - Direct Plan - Growth Option" → "HDFC Mid Cap Fund"; "SBI SMALL CAP FUND" → "SBI Small Cap Fund" */
export function shortFundName(name: unknown): string {
  const full = String(name ?? '').trim();
  const short = full.split(/\s+-\s+|\s*-\s*(?=(?:direct|regular|growth|idcw|dividend)\b)/i)[0].trim() || full;
  if (short !== short.toUpperCase()) return short;
  return short.replace(/[A-Z][A-Z&]*/g, (w) => (ACRONYMS.has(w) ? w : w[0] + w.slice(1).toLowerCase()));
}

/** "Equity Scheme - Small Cap Fund" → "Small Cap" */
function categoryName(category: unknown): string {
  return String(category ?? '').split(' - ').at(-1)!.replace(/\s+fund$/i, '').trim();
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A donut reads well with 3–5 slices: up to 4 named, the rest folded into "Others". */
function donutSlices(items: { label: string; value: number }[], otherLabel: (n: number) => string) {
  if (items.length <= 4) return items;
  const rest = items.slice(4);
  return [...items.slice(0, 4), { label: otherLabel(rest.length), value: rest.reduce((s, r) => s + r.value, 0), other: true }];
}

function portfolioCharts(d: Json): Chart[] {
  const charts: Chart[] = [];
  const total = num(d.total_value);
  const holdings = (Array.isArray(d.holdings) ? d.holdings : []) as { scheme_name: string; current_value: number }[];

  if (total && holdings.length >= 3) {
    const donut: DonutChart = {
      kind: 'donut',
      title: 'Where your money is',
      subtitle: `Split across your ${holdings.length} funds`,
      center_label: rupees(total),
      slices: donutSlices(
        holdings.map((h) => ({ label: shortFundName(h.scheme_name), value: h.current_value })),
        (n) => `${n} other funds`,
      ),
    };
    charts.push(donut);
  }

  const invested = num(d.total_invested);
  const gain = num(d.total_gain);
  if (invested && gain !== null) {
    charts.push({
      kind: 'bar',
      unit: 'inr',
      title: 'Money put in vs. worth now',
      ...(typeof d.note === 'string' && { subtitle: 'Only funds with a known purchase amount are included' }),
      bars: [
        { label: 'Money put in', value: invested, muted: true },
        { label: 'Worth now', value: invested + gain },
      ],
    });
  }
  return charts;
}

function compareChart(d: Json): BarChart | null {
  const funds = ((Array.isArray(d.funds) ? d.funds : []) as { scheme_name: string; growth_of_10000: number | null }[]).filter(
    (f) => num(f.growth_of_10000) !== null,
  );
  const period = (d.growth_period ?? {}) as Json;
  if (funds.length < 2) return null;
  return {
    kind: 'bar',
    unit: 'inr',
    title: 'What ₹10,000 would have become',
    subtitle: `Invested on ${longDate(period.from)}, valued on ${longDate(period.to)}`,
    bars: [
      { label: 'Money put in', value: 10000, muted: true },
      ...funds.map((f) => ({ label: shortFundName(f.scheme_name), value: f.growth_of_10000! })),
    ],
  };
}

function rankChart(d: Json): BarChart | null {
  const top = ((Array.isArray(d.top) ? d.top : []) as { scheme_name: string; return_pct: number | null }[]).filter(
    (f) => num(f.return_pct) !== null,
  );
  if (top.length < 2) return null;
  const categories = Array.isArray(d.categories_matched) ? d.categories_matched : [];
  const years = Number.parseInt(String(d.period ?? ''), 10) || null;
  const period = years ? `over the last ${years === 1 ? 'year' : `${years} years`}` : '';
  return {
    kind: 'bar',
    unit: 'pct',
    title: categories.length === 1 ? `${categoryName(categories[0])} funds with the highest returns` : 'Funds with the highest returns',
    subtitle: `${d.return_type === 'CAGR' ? 'Yearly return (CAGR)' : 'Return'} ${period}. Past returns may not repeat.`.replace(/\s+\./, '.'),
    bars: top.slice(0, 8).map((f) => ({ label: shortFundName(f.scheme_name), value: f.return_pct! })),
  };
}

const SCENARIO_LABELS: [RegExp, string][] = [
  [/^conservative/, 'If returns are low'],
  [/^base/, 'If returns are average'],
  [/^optimistic/, 'If returns are high'],
  [/^expected/, 'At the return you gave'],
];

function futureValueChart(d: Json): BarChart | null {
  const scenarios = (Array.isArray(d.scenarios) ? d.scenarios : []) as {
    scenario: string;
    annual_return_pct: number;
    total_invested?: number;
    future_value?: number;
  }[];
  if (!scenarios.length || scenarios.some((s) => num(s.future_value) === null)) return null;
  const invested = num(scenarios[0].total_invested);
  return {
    kind: 'bar',
    unit: 'inr',
    title: `What it could grow to in ${d.horizon_years} years`,
    subtitle: 'An estimate based on past returns, not a promise',
    bars: [
      ...(invested ? [{ label: 'Money put in', value: invested, muted: true }] : []),
      ...scenarios.map((s) => ({
        label: `${SCENARIO_LABELS.find(([re]) => re.test(s.scenario))?.[1] ?? s.scenario} (${s.annual_return_pct}% a year)`,
        value: s.future_value!,
      })),
    ],
  };
}

function lumpsumChart(d: Json): BarChart | null {
  const amount = num(d.amount_invested);
  const value = num(d.current_value);
  if (!amount || value === null) return null;
  const cagr = num(d.cagr_pct);
  return {
    kind: 'bar',
    unit: 'inr',
    title: `${rupees(amount)} in ${shortFundName(d.scheme_name)}`,
    subtitle: cagr !== null ? `About ${cagr}% a year (CAGR)` : `${d.absolute_return_pct}% in total`,
    bars: [
      { label: `Put in on ${longDate(d.invest_date)}`, value: amount, muted: true },
      { label: `Worth on ${longDate(d.valuation_date)}`, value },
    ],
  };
}

/**
 * Turns selected tool results into chart payloads for the UI, so the model
 * never has to repeat raw data points in its reply.
 */
export function chartsFromToolResult(name: string, data: unknown): Chart[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Json;

  switch (name) {
    case 'get_nav_history': {
      if (!Array.isArray(d.points) || d.points.length < 2) return [];
      const change = ((d.summary ?? {}) as Json).change_pct;
      return [
        {
          kind: 'line',
          title: shortFundName(d.scheme_name) || 'Fund price history',
          subtitle:
            `Price of one unit (NAV), ${longDate(d.from)} to ${longDate(d.to)}` +
            (change != null ? `: ${Number(change) >= 0 ? 'up' : 'down'} ${Math.abs(Number(change))}%` : ''),
          y_label: 'NAV (₹)',
          series: [{ name: 'Price of one unit', points: d.points as [string, number][] }],
        },
      ];
    }
    case 'calculate_sip_returns': {
      if (!Array.isArray(d.yearly_snapshots) || d.yearly_snapshots.length < 2) return [];
      const rows = d.yearly_snapshots as { date: string; invested: number; value: number }[];
      return [
        {
          kind: 'line',
          title: `₹${inr.format(Number(d.monthly_amount))} a month in ${shortFundName(d.scheme_name) || 'this fund'}`,
          subtitle: `Money put in vs. what it grew to${d.xirr_pct != null ? `, about ${d.xirr_pct}% a year (XIRR)` : ''}`,
          y_label: '₹',
          series: [
            { name: 'Money put in', points: rows.map((r) => [r.date, r.invested]) },
            { name: 'What it grew to', points: rows.map((r) => [r.date, r.value]) },
          ],
        },
      ];
    }
    case 'get_my_portfolio':
    case 'analyze_portfolio':
      return portfolioCharts(d);
    case 'compare_funds':
      return [compareChart(d)].filter((c) => c !== null);
    case 'rank_funds_in_category':
      return [rankChart(d)].filter((c) => c !== null);
    case 'estimate_future_value':
      return [futureValueChart(d)].filter((c) => c !== null);
    case 'calculate_lumpsum_returns':
      return [lumpsumChart(d)].filter((c) => c !== null);
    default:
      return [];
  }
}
