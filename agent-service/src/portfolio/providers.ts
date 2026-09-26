import type { Holding } from '../agent/types.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Where the signed-in user's holdings come from. The agent only calls this
 * when the model decides it needs the user's portfolio.
 */
export interface PortfolioProvider {
  readonly name: string;
  getHoldings(userId: string): Promise<Holding[]>;
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

/**
 * Reads holdings straight from your app's MySQL/MariaDB database (e.g. the
 * Laravel app's DB) with read-only SELECT queries you configure. Use a DB user
 * that only has SELECT on the needed tables.
 *
 * PORTFOLIO_HOLDINGS_SQL must return: scheme_code, units, invested_amount (optional)
 * PORTFOLIO_TRANSACTIONS_SQL (optional) must return: scheme_code, date (YYYY-MM-DD), amount
 *   (amount > 0 = purchase/SIP, < 0 = redemption) — enables XIRR.
 * Both receive the user id as the named parameter :user_id.
 */
export class MysqlPortfolioProvider implements PortfolioProvider {
  readonly name = 'mysql';
  private readonly cache = new Map<string, { at: number; holdings: Holding[] }>();

  private constructor(
    private readonly pool: import('mysql2/promise').Pool,
    private readonly holdingsSql: string,
    private readonly transactionsSql: string | undefined,
  ) {}

  static async create(cfg: AppConfig, log: Logger): Promise<MysqlPortfolioProvider> {
    if (!cfg.PORTFOLIO_DB_URL || !cfg.PORTFOLIO_HOLDINGS_SQL) {
      throw new Error('PORTFOLIO_SOURCE=mysql requires PORTFOLIO_DB_URL and PORTFOLIO_HOLDINGS_SQL');
    }
    for (const sql of [cfg.PORTFOLIO_HOLDINGS_SQL, cfg.PORTFOLIO_TRANSACTIONS_SQL]) {
      if (sql && (!/^\s*select\b/i.test(sql) || sql.includes(';'))) {
        throw new Error('Portfolio SQL must be a single SELECT statement');
      }
    }
    const mysql = await import('mysql2/promise');
    const pool = mysql.createPool({
      uri: cfg.PORTFOLIO_DB_URL,
      namedPlaceholders: true,
      connectionLimit: 5,
      dateStrings: true,
      decimalNumbers: true,
    });
    await pool.query('SELECT 1');
    log.info('Portfolio source: MySQL');
    return new MysqlPortfolioProvider(pool, cfg.PORTFOLIO_HOLDINGS_SQL, cfg.PORTFOLIO_TRANSACTIONS_SQL || undefined);
  }

  async getHoldings(userId: string): Promise<Holding[]> {
    if (GUEST.test(userId)) return [];
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.holdings;

    const [rows] = await this.pool.query(this.holdingsSql, { user_id: userId });
    const holdings = new Map<number, Holding>();
    for (const r of rows as Record<string, unknown>[]) {
      const code = Number(r.scheme_code);
      const units = Number(r.units);
      if (!Number.isInteger(code) || code <= 0 || !(units > 0)) continue;
      const existing = holdings.get(code);
      const invested = r.invested_amount == null ? undefined : Number(r.invested_amount);
      if (existing) {
        existing.units += units;
        if (invested !== undefined) existing.invested_amount = (existing.invested_amount ?? 0) + invested;
      } else {
        holdings.set(code, { scheme_code: code, units, ...(invested !== undefined && { invested_amount: invested }) });
      }
    }

    if (this.transactionsSql && holdings.size) {
      const [txRows] = await this.pool.query(this.transactionsSql, { user_id: userId });
      for (const t of txRows as Record<string, unknown>[]) {
        const h = holdings.get(Number(t.scheme_code));
        const date = String(t.date ?? '').slice(0, 10);
        if (!h || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        (h.transactions ??= []).push({ date, amount: Number(t.amount) });
      }
    }

    const list = [...holdings.values()];
    this.cache.set(userId, { at: Date.now(), holdings: list });
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
    return list;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createPortfolioProvider(cfg: AppConfig, log: Logger): Promise<PortfolioProvider | null> {
  switch (cfg.PORTFOLIO_SOURCE) {
    case 'demo':
      log.info('Portfolio source: demo data');
      return new DemoPortfolioProvider();
    case 'mysql':
      return MysqlPortfolioProvider.create(cfg, log);
    default:
      return null;
  }
}
