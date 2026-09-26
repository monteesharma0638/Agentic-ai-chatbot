import type { NavSeries } from '../data/navSeries.js';
import { dayToIso, yearsBetween } from '../lib/dates.js';
import { cagr } from './returns.js';

const TRADING_DAYS = 252;

export interface Drawdown {
  depth: number; // negative ratio, e.g. -0.32
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null;
}

export interface RiskResult {
  from: string;
  to: string;
  annualisedReturn: number | null;
  volatility: number;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: Drawdown;
  bestDay: { date: string; return: number };
  worstDay: { date: string; return: number };
  positiveDaysShare: number;
  benchmark?: {
    beta: number;
    alpha: number | null;
    correlation: number;
    benchmarkReturn: number | null;
    observations: number;
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function maxDrawdown(series: NavSeries): Drawdown {
  let peakIdx = 0;
  let worst = { depth: 0, peakIdx: 0, troughIdx: 0 };
  for (let i = 1; i < series.length; i++) {
    if (series.navs[i] > series.navs[peakIdx]) peakIdx = i;
    const depth = series.navs[i] / series.navs[peakIdx] - 1;
    if (depth < worst.depth) worst = { depth, peakIdx, troughIdx: i };
  }
  let recoveryDate: string | null = null;
  const peakNav = series.navs[worst.peakIdx];
  for (let i = worst.troughIdx + 1; i < series.length; i++) {
    if (series.navs[i] >= peakNav) {
      recoveryDate = dayToIso(series.days[i]);
      break;
    }
  }
  return {
    depth: worst.depth,
    peakDate: dayToIso(series.days[worst.peakIdx]),
    troughDate: dayToIso(series.days[worst.troughIdx]),
    recoveryDate,
  };
}

/**
 * Standard risk statistics over the given (already period-sliced) series.
 * `riskFreeRate` is an annual decimal (0.065 = 6.5%). When a benchmark series
 * is supplied, returns are aligned on common NAV dates for beta/alpha.
 */
export function riskMetrics(series: NavSeries, riskFreeRate: number, benchmark?: NavSeries): RiskResult | null {
  if (series.length < 30) return null;
  const rets: number[] = [];
  let best = { i: 1, r: -Infinity };
  let worst = { i: 1, r: Infinity };
  for (let i = 1; i < series.length; i++) {
    const r = series.navs[i] / series.navs[i - 1] - 1;
    rets.push(r);
    if (r > best.r) best = { i, r };
    if (r < worst.r) worst = { i, r };
  }
  const volatility = stdev(rets) * Math.sqrt(TRADING_DAYS);
  const years = yearsBetween(series.firstDay, series.lastDay);
  const annualisedReturn = cagr(series.navs[0], series.navs[series.length - 1], years);
  const rfDaily = (1 + riskFreeRate) ** (1 / TRADING_DAYS) - 1;
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r - rfDaily) ** 2))) * Math.sqrt(TRADING_DAYS);
  const excess = annualisedReturn === null ? null : annualisedReturn - riskFreeRate;

  const result: RiskResult = {
    from: dayToIso(series.firstDay),
    to: dayToIso(series.lastDay),
    annualisedReturn,
    volatility,
    sharpe: excess !== null && volatility > 0 ? excess / volatility : null,
    sortino: excess !== null && downside > 0 ? excess / downside : null,
    maxDrawdown: maxDrawdown(series),
    bestDay: { date: dayToIso(series.days[best.i]), return: best.r },
    worstDay: { date: dayToIso(series.days[worst.i]), return: worst.r },
    positiveDaysShare: rets.filter((r) => r > 0).length / rets.length,
  };

  if (benchmark && !benchmark.isEmpty) {
    const bmByDay = new Map<number, number>();
    for (let i = 0; i < benchmark.length; i++) bmByDay.set(benchmark.days[i], benchmark.navs[i]);
    const fundRets: number[] = [];
    const bmRets: number[] = [];
    let prev: { f: number; b: number } | null = null;
    let firstCommon: { f: number; b: number; day: number } | null = null;
    let lastCommon: { f: number; b: number; day: number } | null = null;
    for (let i = 0; i < series.length; i++) {
      const b = bmByDay.get(series.days[i]);
      if (b === undefined) continue;
      const f = series.navs[i];
      if (prev) {
        fundRets.push(f / prev.f - 1);
        bmRets.push(b / prev.b - 1);
      }
      prev = { f, b };
      firstCommon ??= { f, b, day: series.days[i] };
      lastCommon = { f, b, day: series.days[i] };
    }
    if (fundRets.length >= 30 && firstCommon && lastCommon) {
      const mf = mean(fundRets);
      const mb = mean(bmRets);
      let cov = 0;
      let varB = 0;
      let varF = 0;
      for (let i = 0; i < fundRets.length; i++) {
        cov += (fundRets[i] - mf) * (bmRets[i] - mb);
        varB += (bmRets[i] - mb) ** 2;
        varF += (fundRets[i] - mf) ** 2;
      }
      const beta = cov / varB;
      const commonYears = yearsBetween(firstCommon.day, lastCommon.day);
      const fundRet = cagr(firstCommon.f, lastCommon.f, commonYears);
      const bmRet = cagr(firstCommon.b, lastCommon.b, commonYears);
      result.benchmark = {
        beta,
        alpha: fundRet !== null && bmRet !== null ? fundRet - (riskFreeRate + beta * (bmRet - riskFreeRate)) : null,
        correlation: cov / Math.sqrt(varB * varF),
        benchmarkReturn: bmRet,
        observations: fundRets.length,
      };
    }
  }
  return result;
}
