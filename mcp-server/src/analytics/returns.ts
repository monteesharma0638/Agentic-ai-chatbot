import type { NavPoint, NavSeries } from '../data/navSeries.js';
import { addDays, addMonths, addYears, dayToIso, isoToDay, yearsBetween } from '../lib/dates.js';

/** Compound annual growth rate as a decimal ratio, or null when undefined. */
export function cagr(startValue: number, endValue: number, years: number): number | null {
  if (!(startValue > 0) || !(endValue > 0) || !(years > 0)) return null;
  return (endValue / startValue) ** (1 / years) - 1;
}

export interface PeriodReturn {
  start: NavPoint;
  end: NavPoint;
  years: number;
  /** Total change as a ratio (0.25 = +25%). */
  absolute: number;
  /** CAGR for periods of one year or more, otherwise null (industry convention). */
  annualised: number | null;
}

export function returnBetween(series: NavSeries, startIdx: number, endIdx: number): PeriodReturn | null {
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
  const start = series.point(startIdx);
  const end = series.point(endIdx);
  const years = yearsBetween(series.days[startIdx], series.days[endIdx]);
  return {
    start,
    end,
    years,
    absolute: end.nav / start.nav - 1,
    annualised: years >= 1 - 1e-9 ? cagr(start.nav, end.nav, years) : null,
  };
}

/**
 * Point-to-point return. The start uses the NAV prevailing on `fromIso`
 * (on or before), the end the NAV on or before `toIso` (default: latest).
 */
export function pointToPoint(series: NavSeries, fromIso: string, toIso?: string): PeriodReturn | null {
  const endIdx = toIso ? series.indexOnOrBefore(isoToDay(toIso)) : series.length - 1;
  const startIdx = series.indexOnOrBefore(isoToDay(fromIso));
  return returnBetween(series, startIdx, endIdx);
}

export const TRAILING_PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', 'SI'] as const;
export type TrailingPeriod = (typeof TRAILING_PERIODS)[number];

export function periodStart(endIso: string, period: TrailingPeriod, firstIso: string): string {
  switch (period) {
    case '1W':
      return addDays(endIso, -7);
    case 'YTD':
      return `${Number(endIso.slice(0, 4)) - 1}-12-31`;
    case 'SI':
      return firstIso;
    default: {
      const n = Number(period.slice(0, -1));
      return period.endsWith('M') ? addMonths(endIso, -n) : addYears(endIso, -n);
    }
  }
}

/**
 * Trailing returns ending at the latest NAV. Periods longer than the fund's
 * history are null rather than silently shortened.
 */
export function trailingReturns(series: NavSeries): Record<TrailingPeriod, PeriodReturn | null> {
  const out = {} as Record<TrailingPeriod, PeriodReturn | null>;
  const end = series.last();
  const first = series.first();
  for (const period of TRAILING_PERIODS) {
    const startIso = periodStart(end.date, period, first.date);
    if (period !== 'SI' && isoToDay(startIso) < series.firstDay) {
      out[period] = null;
      continue;
    }
    out[period] = returnBetween(series, series.indexOnOrBefore(isoToDay(startIso)), series.length - 1);
  }
  return out;
}

export interface CalendarYearReturn {
  year: number;
  return: number;
  /** True for the launch year and the current (year-to-date) year. */
  partial: boolean;
}

export function calendarYearReturns(series: NavSeries): CalendarYearReturn[] {
  if (series.length < 2) return [];
  const firstYear = Number(series.first().date.slice(0, 4));
  const lastIso = series.last().date;
  const lastYear = Number(lastIso.slice(0, 4));
  const out: CalendarYearReturn[] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const startIdx = y === firstYear ? 0 : series.indexOnOrBefore(isoToDay(`${y - 1}-12-31`));
    const endIdx = series.indexOnOrBefore(isoToDay(`${y}-12-31`));
    const r = returnBetween(series, startIdx, endIdx);
    if (!r) continue;
    out.push({ year: y, return: r.absolute, partial: y === firstYear || (y === lastYear && !lastIso.endsWith('12-31')) });
  }
  return out;
}

export interface Distribution {
  observations: number;
  mean: number;
  median: number;
  min: { value: number; end_date: string };
  max: { value: number; end_date: string };
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** Share of windows (0..1) with a negative return. */
  negativeShare: number;
  /** Share of windows (0..1) beating each hurdle rate. */
  above: Record<string, number>;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Rolling returns: for every NAV date, the return over the preceding
 * `windowYears` (CAGR for windows >= 1 year). Far more honest than a single
 * point-to-point number because it shows the range of outcomes an investor
 * who entered on any day would have seen.
 */
export function rollingReturns(
  series: NavSeries,
  windowYears: number,
  lookbackYears?: number,
): Distribution | null {
  if (series.length < 2) return null;
  const windowMonths = Math.round(windowYears * 12);
  let firstEndIdx = series.indexOnOrAfter(isoToDay(addMonths(series.first().date, windowMonths)));
  if (lookbackYears) {
    const lookbackStart = series.indexOnOrAfter(isoToDay(addYears(series.last().date, -lookbackYears)));
    firstEndIdx = Math.max(firstEndIdx, lookbackStart);
  }
  if (firstEndIdx < 0) return null;

  const values: { value: number; day: number }[] = [];
  for (let i = firstEndIdx; i < series.length; i++) {
    const startIso = addMonths(dayToIso(series.days[i]), -windowMonths);
    const startIdx = series.indexOnOrBefore(isoToDay(startIso));
    if (startIdx < 0) continue;
    const ratio = series.navs[i] / series.navs[startIdx];
    const value = windowYears >= 1 ? ratio ** (1 / windowYears) - 1 : ratio - 1;
    values.push({ value, day: series.days[i] });
  }
  if (values.length === 0) return null;

  const sorted = values.map((v) => v.value).sort((a, b) => a - b);
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v.value < min.value) min = v;
    if (v.value > max.value) max = v;
  }
  const share = (pred: (x: number) => boolean) => sorted.filter(pred).length / sorted.length;
  return {
    observations: values.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: percentile(sorted, 0.5),
    min: { value: min.value, end_date: dayToIso(min.day) },
    max: { value: max.value, end_date: dayToIso(max.day) },
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    negativeShare: share((x) => x < 0),
    above: Object.fromEntries([0.06, 0.08, 0.1, 0.12, 0.15].map((h) => [`${h * 100}%`, share((x) => x > h)])),
  };
}
