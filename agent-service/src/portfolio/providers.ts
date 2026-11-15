import type { Holding } from '../agent/types.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Where the signed-in user's holdings come from. The agent only calls this
 * when the model decides it needs the user's portfolio.
 *
 * `token` is the caller's own verified bearer token, forwarded to the host app's
 * read API so it returns *that* user's holdings (never a shared/other user's).
 */
export interface PortfolioProvider {
  readonly name: string;
  getHoldings(userId: string, token?: string, signal?: AbortSignal): Promise<Holding[]>;
  close?(): Promise<void>;
}

const GUEST = /^guest:/;

/** Fixed sample portfolio for local development and demos. */
export class DemoPortfolioProvider implements PortfolioProvider {
  readonly name = 'demo';

  async getHoldings(userId: string): Promise<Holding[]> {
    if (GUEST.test(userId)) return [];
    const monthly = (year: number, month: number, count: number, amount: number) =>
      Array.from({ length: count }, (_, i) => ({
        date: new Date(Date.UTC(year, month - 1 + i, 5)).toISOString().slice(0, 10),
        amount,
      }));
    return [
      { scheme_code: 122639, units: 1450.2, transactions: monthly(2022, 1, 36, 3000) }, // Parag Parikh Flexi Cap
      { scheme_code: 120716, units: 520.75, transactions: monthly(2023, 4, 24, 2500) }, // UTI Nifty 50 Index
      { scheme_code: 119091, units: 4.1, invested_amount: 20000 }, // HDFC Liquid
    ];
  }
}

/** One row of the Robo Rupee holdings API (`GET /api/holdings/get`). Strings are decimal values. */
interface RoboRupeeRecord {
  scheme?: string;
  isin?: string | null;
  asset_class?: string | null;
  asset_type?: string | null;
  units?: string | number | null;
  nav?: string | number | null;
  nav_date?: string | null;
  cost_value?: string | number | null;
  current_value?: string | number | null;
}

const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

const ISIN = /^INF[A-Z0-9]{9}$/;
/** Normalises an ISIN, or returns undefined for a missing/malformed one (so it falls back to name matching). */
const cleanIsin = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim().toUpperCase();
  return ISIN.test(s) ? s : undefined;
};

/**
 * Reads the signed-in user's mutual fund holdings from the Robo Rupee admin API.
 * The API identifies the customer entirely from the bearer token, so each user's
 * own forwarded JWT is used — a shared token would return one customer's data to
 * everyone. Rows are aggregated per scheme (one row per folio in the source) and
 * handed to `analyze_portfolio`, which re-values them at the live AMFI NAV via the
 * ISIN; the API's own `current_value` is kept only as a fallback.
 */
export class RoboRupeePortfolioProvider implements PortfolioProvider {
  readonly name = 'roborupee';

  constructor(
    private readonly cfg: Pick<AppConfig, 'ROBORUPEE_API_URL' | 'ROBORUPEE_HOLDINGS_PATH' | 'ROBORUPEE_API_TOKEN' | 'ROBORUPEE_TIMEOUT_MS'>,
    private readonly log: Logger,
  ) {}

  async getHoldings(userId: string, token?: string, signal?: AbortSignal): Promise<Holding[]> {
    if (GUEST.test(userId)) return [];
    const bearer = token || this.cfg.ROBORUPEE_API_TOKEN;
    if (!bearer) {
      throw new Error('Cannot read your portfolio: no access token was provided for the holdings service.');
    }

    const url = new URL(this.cfg.ROBORUPEE_HOLDINGS_PATH, this.cfg.ROBORUPEE_API_URL).toString();
    const timeout = AbortSignal.timeout(this.cfg.ROBORUPEE_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, signal: abort });
    } catch (err) {
      if (signal?.aborted) throw err;
      this.log.warn({ err: (err as Error).message, user: userId }, 'holdings API request failed');
      throw new Error('Your portfolio is unavailable right now. Please try again in a moment.');
    }
    if (!res.ok) {
      this.log.warn({ status: res.status, user: userId }, 'holdings API returned an error');
      throw new Error(
        res.status === 401 || res.status === 403
          ? 'Your session has expired. Please refresh the page and sign in again to see your portfolio.'
          : 'Your portfolio is unavailable right now. Please try again in a moment.',
      );
    }

    const body = (await res.json().catch(() => null)) as { success?: boolean; records?: RoboRupeeRecord[] } | null;
    if (!body || body.success === false || !Array.isArray(body.records)) {
      throw new Error('Your portfolio is unavailable right now. Please try again in a moment.');
    }
    return aggregateHoldings(body.records);
  }
}

/** Folios of the same scheme (same ISIN) are merged into one holding; units and values add up. */
export function aggregateHoldings(records: RoboRupeeRecord[]): Holding[] {
  const byScheme = new Map<string, Holding & { current_value: number; units: number }>();
  for (const r of records) {
    const isin = cleanIsin(r.isin);
    const name = r.scheme ? String(r.scheme).trim() : undefined;
    const key = isin || name;
    if (!key) continue;
    const units = toNum(r.units);
    const cost = toNum(r.cost_value);
    const value = toNum(r.current_value);
    const existing = byScheme.get(key);
    if (existing) {
      existing.units += units;
      existing.current_value += value;
      if (cost > 0) existing.invested_amount = (existing.invested_amount ?? 0) + cost;
    } else {
      byScheme.set(key, {
        ...(isin && { isin }),
        ...(name && { scheme_name: name }),
        ...(r.asset_class && { asset_class: String(r.asset_class) }),
        units,
        current_value: value,
        ...(cost > 0 && { invested_amount: cost }),
        ...(r.nav != null && toNum(r.nav) > 0 && { nav: toNum(r.nav) }),
        ...(r.nav_date && { nav_date: String(r.nav_date) }),
      });
    }
  }
  // analyze_portfolio accepts at most 60 holdings; keep the largest by value if a CAS is unusually long.
  return [...byScheme.values()].filter((h) => h.units > 0).sort((a, b) => b.current_value - a.current_value).slice(0, 60);
}

export async function createPortfolioProvider(cfg: AppConfig, log: Logger): Promise<PortfolioProvider | null> {
  if (cfg.PORTFOLIO_SOURCE === 'demo') {
    log.info('Portfolio source: demo data');
    return new DemoPortfolioProvider();
  }
  if (cfg.PORTFOLIO_SOURCE === 'roborupee') {
    log.info({ url: cfg.ROBORUPEE_API_URL }, 'Portfolio source: Robo Rupee holdings API');
    return new RoboRupeePortfolioProvider(cfg, log);
  }
  return null;
}
