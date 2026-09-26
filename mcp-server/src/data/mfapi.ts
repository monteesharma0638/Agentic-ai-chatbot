import { config } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { ddmmyyyyToIso } from '../lib/dates.js';
import { httpGet, UpstreamError } from '../lib/http.js';
import { NavSeries } from './navSeries.js';

export interface MfapiMeta {
  fund_house: string;
  scheme_type: string;
  scheme_category: string;
  scheme_code: number;
  scheme_name: string;
  isin_growth: string | null;
  isin_div_reinvestment: string | null;
}

export interface SchemeHistory {
  meta: MfapiMeta;
  series: NavSeries;
}

interface MfapiResponse {
  meta?: MfapiMeta;
  data?: { date: string; nav: string }[];
  status?: string;
}

/**
 * mfapi.in — free mirror of AMFI's historical NAV data for every Indian
 * mutual fund scheme (daily NAVs back to 2006 for older schemes).
 */
export class MfapiClient {
  private readonly cache = new TtlCache<SchemeHistory>(config.historyCacheSize, config.historyTtlMs);

  getHistory(code: number): Promise<SchemeHistory> {
    return this.cache.getOrLoad(String(code), async () => {
      const res = await httpGet(`${config.mfapiBaseUrl}/mf/${code}`);
      const body = (await res.json()) as MfapiResponse;
      if (!body.meta || !Array.isArray(body.data) || body.data.length === 0) {
        throw new UpstreamError(`No NAV history found for scheme code ${code}`, 404);
      }
      const series = new NavSeries(
        body.data.map((p) => ({ date: ddmmyyyyToIso(p.date), nav: Number(p.nav) })),
      );
      if (series.isEmpty) throw new UpstreamError(`No valid NAV history for scheme code ${code}`, 404);
      return { meta: body.meta, series };
    });
  }

  /** Fallback search used only when the AMFI master list is unavailable. */
  async search(query: string): Promise<{ schemeCode: number; schemeName: string }[]> {
    const res = await httpGet(`${config.mfapiBaseUrl}/mf/search?q=${encodeURIComponent(query)}`);
    return (await res.json()) as { schemeCode: number; schemeName: string }[];
  }
}
