import { dayToIso, isoToDay } from '../lib/dates.js';

export interface NavPoint {
  date: string; // ISO YYYY-MM-DD
  nav: number;
}

/**
 * Immutable, ascending NAV time series with O(log n) date lookups.
 * NAVs only exist on business days, so lookups snap to the nearest
 * available date on the requested side.
 */
export class NavSeries {
  readonly days: number[];
  readonly navs: number[];

  constructor(points: NavPoint[]) {
    const byDay = new Map<number, number>();
    for (const p of points) {
      if (Number.isFinite(p.nav) && p.nav > 0) byDay.set(isoToDay(p.date), p.nav);
    }
    const days = [...byDay.keys()].sort((a, b) => a - b);
    this.days = days;
    this.navs = days.map((d) => byDay.get(d)!);
  }

  static fromArrays(days: number[], navs: number[]): NavSeries {
    const s = Object.create(NavSeries.prototype) as NavSeries;
    (s as { days: number[] }).days = days;
    (s as { navs: number[] }).navs = navs;
    return s;
  }

  get length(): number {
    return this.days.length;
  }

  get isEmpty(): boolean {
    return this.days.length === 0;
  }

  point(i: number): NavPoint {
    return { date: dayToIso(this.days[i]), nav: this.navs[i] };
  }

  first(): NavPoint {
    return this.point(0);
  }

  last(): NavPoint {
    return this.point(this.days.length - 1);
  }

  get firstDay(): number {
    return this.days[0];
  }

  get lastDay(): number {
    return this.days[this.days.length - 1];
  }

  /** Index of the last point with day <= `day`, or -1. */
  indexOnOrBefore(day: number): number {
    let lo = 0;
    let hi = this.days.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid] <= day) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /** Index of the first point with day >= `day`, or -1. */
  indexOnOrAfter(day: number): number {
    let lo = 0;
    let hi = this.days.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid] >= day) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  onOrBefore(iso: string): NavPoint | null {
    const i = this.indexOnOrBefore(isoToDay(iso));
    return i < 0 ? null : this.point(i);
  }

  onOrAfter(iso: string): NavPoint | null {
    const i = this.indexOnOrAfter(isoToDay(iso));
    return i < 0 ? null : this.point(i);
  }

  /** Points with fromDay <= day <= toDay. */
  slice(fromDay: number, toDay: number): NavSeries {
    const start = this.indexOnOrAfter(fromDay);
    const end = this.indexOnOrBefore(toDay);
    if (start < 0 || end < 0 || end < start) return NavSeries.fromArrays([], []);
    return NavSeries.fromArrays(this.days.slice(start, end + 1), this.navs.slice(start, end + 1));
  }

  withPoint(point: NavPoint): NavSeries {
    const day = isoToDay(point.date);
    if (!this.isEmpty && day <= this.lastDay) return this;
    return NavSeries.fromArrays([...this.days, day], [...this.navs, point.nav]);
  }
}
