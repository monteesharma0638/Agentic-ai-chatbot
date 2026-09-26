import { AmfiDirectory, normalizeCategory, type SchemeRecord } from './amfi.js';
import { MfapiClient } from './mfapi.js';
import type { NavSeries } from './navSeries.js';
import { searchSchemes, type SearchFilters } from './search.js';

export interface Fund {
  code: number;
  name: string;
  fundHouse: string;
  category: string;
  schemeType: string;
  plan: 'Direct' | 'Regular' | null;
  isin: string | null;
  series: NavSeries;
  /** Set when the fund was looked up by name rather than scheme code. */
  matchedFrom?: { query: string; other_matches: string[] };
}

export interface SchemeSummary {
  scheme_code: number;
  scheme_name: string;
  fund_house?: string;
  category?: string;
  plan?: string | null;
  latest_nav?: number | null;
  nav_date?: string | null;
}

export function summarize(s: SchemeRecord): SchemeSummary {
  return {
    scheme_code: s.code,
    scheme_name: s.name,
    fund_house: s.fundHouse,
    category: s.category,
    plan: s.plan,
    latest_nav: s.nav,
    nav_date: s.navDate,
  };
}

/**
 * Single entry point for fund data. Combines the AMFI master list (fresh
 * daily NAVs + categories) with mfapi.in history (full NAV time series).
 */
export class FundRepository {
  constructor(
    readonly directory = new AmfiDirectory(),
    readonly mfapi = new MfapiClient(),
  ) {}

  async getScheme(code: number): Promise<SchemeRecord | undefined> {
    try {
      return (await this.directory.get()).byCode.get(code);
    } catch {
      return undefined;
    }
  }

  async getFund(code: number): Promise<Fund> {
    const [history, record] = await Promise.all([this.mfapi.getHistory(code), this.getScheme(code)]);
    let series = history.series;
    // AMFI usually publishes the day's NAV a few hours before mfapi.in picks it up.
    if (record?.nav && record.navDate) series = series.withPoint({ date: record.navDate, nav: record.nav });
    const meta = history.meta;
    return {
      code,
      name: record?.name ?? meta.scheme_name,
      fundHouse: record?.fundHouse ?? meta.fund_house,
      category: record?.category ?? normalizeCategory(meta.scheme_category ?? ''),
      schemeType: record?.schemeType ?? meta.scheme_type,
      plan: record?.plan ?? (/direct/i.test(meta.scheme_name) ? 'Direct' : /regular/i.test(meta.scheme_name) ? 'Regular' : null),
      isin: record?.isinGrowth ?? record?.isinReinvestment ?? meta.isin_growth ?? meta.isin_div_reinvestment,
      series,
    };
  }

  async search(query: string, filters: SearchFilters, limit: number): Promise<SchemeSummary[]> {
    try {
      const dir = await this.directory.get();
      return searchSchemes(dir.schemes, query, filters, limit).map((h) => summarize(h.scheme));
    } catch (err) {
      console.error('[repo] AMFI directory unavailable, falling back to mfapi search:', (err as Error).message);
      const results = await this.mfapi.search(query);
      return results.slice(0, limit).map((r) => ({ scheme_code: r.schemeCode, scheme_name: r.schemeName }));
    }
  }
}
