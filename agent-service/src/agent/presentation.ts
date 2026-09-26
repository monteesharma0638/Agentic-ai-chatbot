import type { Chart } from './types.js';

/** Friendly progress labels shown in the chat UI while a tool runs. */
const LABELS: Record<string, string> = {
  search_funds: 'Searching funds',
  list_categories: 'Looking up categories',
  list_fund_houses: 'Looking up fund houses',
  get_fund_overview: 'Fetching fund overview',
  get_nav_history: 'Loading NAV history',
  get_nav_on_date: 'Looking up historical NAV',
  calculate_lumpsum_returns: 'Calculating lumpsum returns',
  calculate_sip_returns: 'Back-testing SIP',
  estimate_future_value: 'Estimating future value',
  get_rolling_returns: 'Analysing rolling returns',
  get_risk_metrics: 'Measuring risk',
  compare_funds: 'Comparing funds',
  rank_funds_in_category: 'Ranking funds in category',
  analyze_portfolio: 'Analysing portfolio',
  get_my_portfolio: 'Reviewing your portfolio',
};

export function toolLabel(name: string): string {
  return LABELS[name] ?? `Running ${name.replace(/_/g, ' ')}`;
}

type Json = Record<string, unknown>;

/**
 * Turns selected tool results into chart payloads for the UI, so the model
 * never has to repeat raw data points in its reply.
 */
export function chartFromToolResult(name: string, data: unknown): Chart | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Json;

  if (name === 'get_nav_history' && Array.isArray(d.points) && d.points.length > 1) {
    const summary = (d.summary ?? {}) as Json;
    return {
      kind: 'line',
      title: String(d.scheme_name ?? 'NAV history'),
      subtitle: `${d.from} → ${d.to}${summary.change_pct != null ? ` · ${Number(summary.change_pct) >= 0 ? '+' : ''}${summary.change_pct}%` : ''}`,
      y_label: 'NAV (₹)',
      series: [{ name: 'NAV', points: d.points as [string, number][] }],
    };
  }

  if (name === 'calculate_sip_returns' && Array.isArray(d.yearly_snapshots) && d.yearly_snapshots.length > 1) {
    const rows = d.yearly_snapshots as { date: string; invested: number; value: number }[];
    return {
      kind: 'line',
      title: `SIP growth · ${String(d.scheme_name ?? '')}`,
      subtitle: `₹${d.monthly_amount}/month · XIRR ${d.xirr_pct ?? '–'}%`,
      y_label: '₹',
      series: [
        { name: 'Invested', points: rows.map((r) => [r.date, r.invested]) },
        { name: 'Value', points: rows.map((r) => [r.date, r.value]) },
      ],
    };
  }

  return null;
}
