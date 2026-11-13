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

export async function createPortfolioProvider(cfg: AppConfig, log: Logger): Promise<PortfolioProvider | null> {
  if (cfg.PORTFOLIO_SOURCE === 'demo') {
    log.info('Portfolio source: demo data');
    return new DemoPortfolioProvider();
  }
  return null;
}
