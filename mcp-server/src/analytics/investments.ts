import type { NavSeries } from '../data/navSeries.js';
import { dateInMonth, dayToIso, isoToDay, yearsBetween } from '../lib/dates.js';
import { cagr } from './returns.js';

export interface CashFlow {
  day: number;
  /** Negative = money invested, positive = money received / current value. */
  amount: number;
}

/**
 * Extended internal rate of return (annualised), the standard way Indian
 * platforms report SIP / portfolio returns. Newton-Raphson with a bisection
 * fallback. Returns null when there is no sign change (undefined IRR).
 */
export function xirr(flows: CashFlow[]): number | null {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const d0 = Math.min(...flows.map((f) => f.day));
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / (1 + r) ** ((f.day - d0) / 365), 0);
  const dnpv = (r: number) =>
    flows.reduce((s, f) => {
      const t = (f.day - d0) / 365;
      return s - (t * f.amount) / (1 + r) ** (t + 1);
    }, 0);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const v = npv(r);
    const d = dnpv(r);
    if (!Number.isFinite(v) || !Number.isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }

  // Bisection fallback on a wide bracket.
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

export interface LumpsumResult {
  investDate: string;
  investNav: number;
  units: number;
  valuationDate: string;
  valuationNav: number;
  value: number;
  absolute: number;
  annualised: number | null;
  startAdjusted: boolean;
}

/** One-time investment: bought at the first NAV on/after `startIso`. */
export function simulateLumpsum(series: NavSeries, amount: number, startIso: string, endIso?: string): LumpsumResult {
  let startIdx = series.indexOnOrAfter(isoToDay(startIso));
  const startAdjusted = isoToDay(startIso) < series.firstDay;
  if (startAdjusted) startIdx = 0;
  const endIdx = endIso ? series.indexOnOrBefore(isoToDay(endIso)) : series.length - 1;
  if (startIdx < 0 || endIdx <= startIdx) throw new Error('No NAV data for the requested investment period.');
  const buy = series.point(startIdx);
  const sell = series.point(endIdx);
  const units = amount / buy.nav;
  const value = units * sell.nav;
  const years = yearsBetween(series.days[startIdx], series.days[endIdx]);
  return {
    investDate: buy.date,
    investNav: buy.nav,
    units,
    valuationDate: sell.date,
    valuationNav: sell.nav,
    value,
    absolute: value / amount - 1,
    annualised: years >= 1 ? cagr(amount, value, years) : null,
    startAdjusted,
  };
}

export interface SipOptions {
  monthlyAmount: number;
  startIso: string;
  endIso?: string;
  /** Day of month for the instalment (1–28 typical). Defaults to the start date's day. */
  sipDay?: number;
  /** Annual step-up in % (e.g. 10 = increase SIP by 10% every 12 instalments). */
  stepUpPct?: number;
}

export interface SipSnapshot {
  date: string;
  instalments: number;
  invested: number;
  value: number;
}

export interface SipResult {
  firstInstalment: string;
  lastInstalment: string;
  instalments: number;
  invested: number;
  units: number;
  valuationDate: string;
  valuationNav: number;
  value: number;
  absolute: number;
  xirr: number | null;
  startAdjusted: boolean;
  snapshots: SipSnapshot[];
}

/**
 * Monthly SIP back-test. Each instalment buys units at the first NAV on/after
 * the SIP date (as AMCs process it on the next business day).
 */
export function simulateSip(series: NavSeries, opts: SipOptions): SipResult {
  const endDay = opts.endIso ? Math.min(isoToDay(opts.endIso), series.lastDay) : series.lastDay;
  let startIso = opts.startIso;
  const startAdjusted = isoToDay(startIso) < series.firstDay;
  if (startAdjusted) startIso = series.first().date;
  const sipDay = opts.sipDay ?? Number(startIso.slice(8, 10));
  const stepUp = (opts.stepUpPct ?? 0) / 100;

  let y = Number(startIso.slice(0, 4));
  let m = Number(startIso.slice(5, 7));
  if (sipDay < Number(startIso.slice(8, 10))) {
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  const flows: CashFlow[] = [];
  const snapshots: SipSnapshot[] = [];
  let units = 0;
  let invested = 0;
  let count = 0;
  let firstInstalment = '';
  let lastInstalment = '';

  for (let guard = 0; guard < 1200; guard++) {
    const target = dateInMonth(y, m, sipDay);
    const idx = series.indexOnOrAfter(isoToDay(target));
    if (idx < 0 || series.days[idx] > endDay) break;
    const nav = series.navs[idx];
    const amount = opts.monthlyAmount * (1 + stepUp) ** Math.floor(count / 12);
    units += amount / nav;
    invested += amount;
    count++;
    const date = dayToIso(series.days[idx]);
    firstInstalment ||= date;
    lastInstalment = date;
    flows.push({ day: series.days[idx], amount: -amount });
    if (count % 12 === 0) snapshots.push({ date, instalments: count, invested, value: units * nav });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  if (count === 0) throw new Error('No SIP instalment falls inside the available NAV history for that period.');

  const valIdx = series.indexOnOrBefore(endDay);
  const valuationNav = series.navs[valIdx];
  const value = units * valuationNav;
  flows.push({ day: series.days[valIdx], amount: value });
  const valuationDate = dayToIso(series.days[valIdx]);
  snapshots.push({ date: valuationDate, instalments: count, invested, value });

  return {
    firstInstalment,
    lastInstalment,
    instalments: count,
    invested,
    units,
    valuationDate,
    valuationNav,
    value,
    absolute: value / invested - 1,
    xirr: xirr(flows),
    startAdjusted,
    snapshots: thin(snapshots, 12),
  };
}

/** Keeps at most `max` rows, always including the last one. */
function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const out = rows.filter((_, i) => i % step === step - 1);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

export interface ProjectionInput {
  lumpsum: number;
  monthlySip: number;
  years: number;
  annualReturn: number;
  stepUpPct?: number;
  inflationPct?: number;
}

export interface ProjectionResult {
  invested: number;
  futureValue: number;
  gain: number;
  /** Future value in today's rupees after inflation. */
  realValue: number | null;
}

/** Deterministic corpus projection with monthly compounding (SIP paid at the start of each month). */
export function projectCorpus(input: ProjectionInput): ProjectionResult {
  const months = Math.round(input.years * 12);
  const rm = (1 + input.annualReturn) ** (1 / 12) - 1;
  const stepUp = (input.stepUpPct ?? 0) / 100;
  let value = input.lumpsum;
  let invested = input.lumpsum;
  let sip = input.monthlySip;
  for (let i = 0; i < months; i++) {
    if (i > 0 && i % 12 === 0) sip *= 1 + stepUp;
    value = (value + sip) * (1 + rm);
    invested += sip;
  }
  const realValue =
    input.inflationPct !== undefined ? value / (1 + input.inflationPct / 100) ** input.years : null;
  return { invested, futureValue: value, gain: value - invested, realValue };
}
