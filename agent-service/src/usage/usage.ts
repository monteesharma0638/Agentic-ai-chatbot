import type { AppConfig } from '../config.js';
import type { Mongo, UsageDoc } from '../db/mongo.js';
import { getMongo } from '../db/mongo.js';
import type { Logger } from '../logger.js';

/** The same shape both the gate check and the server-to-server usage endpoint return. */
export interface UsageStatus {
  user_id: string;
  unit: 'tokens';
  /** Tokens used in the current window. */
  used: number;
  /** Per-window budget; 0 means no limit. */
  limit: number;
  /** limit - used, never below 0; null when there is no limit. */
  remaining: number | null;
  /** True only when a limit is set and it is spent. */
  blocked: boolean;
  /** When the current window resets (ISO 8601 UTC). */
  reset_at: string;
  /** All-time tokens and answered messages, for reporting. */
  lifetime_tokens: number;
  messages: number;
}

export interface UsageService {
  /** Current usage for a user, with `blocked` set when the budget is spent. */
  check(userId: string): Promise<UsageStatus>;
  /** Add the tokens an answer used to the user's running total. */
  record(userId: string, tokens: number): Promise<void>;
}

function status(userId: string, doc: UsageDoc | null, limit: number, windowMs: number, now = Date.now()): UsageStatus {
  const windowLive = doc && now - doc.windowStart.getTime() < windowMs;
  const used = windowLive ? doc!.used : 0;
  const windowStart = windowLive ? doc!.windowStart.getTime() : now;
  return {
    user_id: userId,
    unit: 'tokens',
    used,
    limit,
    remaining: limit > 0 ? Math.max(0, limit - used) : null,
    blocked: limit > 0 && used >= limit,
    reset_at: new Date(windowStart + windowMs).toISOString(),
    lifetime_tokens: doc?.lifetimeTokens ?? 0,
    messages: doc?.messages ?? 0,
  };
}

/** MongoDB-backed usage, with an atomic window-reset-and-increment on record. */
export class MongoUsageService implements UsageService {
  constructor(
    private readonly mongo: Mongo,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async check(userId: string): Promise<UsageStatus> {
    return status(userId, await this.mongo.usage.findOne({ _id: userId }), this.limit, this.windowMs);
  }

  async record(userId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.windowMs);
    await this.mongo.usage.updateOne(
      { _id: userId },
      [
        { $set: { _reset: { $or: [{ $eq: [{ $ifNull: ['$windowStart', null] }, null] }, { $lt: ['$windowStart', cutoff] }] } } },
        {
          $set: {
            windowStart: { $cond: ['$_reset', now, '$windowStart'] },
            used: { $add: [{ $cond: ['$_reset', 0, { $ifNull: ['$used', 0] }] }, tokens] },
            lifetimeTokens: { $add: [{ $ifNull: ['$lifetimeTokens', 0] }, tokens] },
            messages: { $add: [{ $ifNull: ['$messages', 0] }, 1] },
            updatedAt: now,
          },
        },
        { $unset: '_reset' },
      ],
      { upsert: true },
    );
  }
}

/** In-memory usage for local dev and tests (lost on restart). */
export class MemoryUsageService implements UsageService {
  private readonly map = new Map<string, UsageDoc>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async check(userId: string): Promise<UsageStatus> {
    return status(userId, this.map.get(userId) ?? null, this.limit, this.windowMs);
  }

  async record(userId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const now = Date.now();
    const existing = this.map.get(userId);
    const live = existing && now - existing.windowStart.getTime() < this.windowMs;
    this.map.set(userId, {
      _id: userId,
      windowStart: live ? existing!.windowStart : new Date(now),
      used: (live ? existing!.used : 0) + tokens,
      lifetimeTokens: (existing?.lifetimeTokens ?? 0) + tokens,
      messages: (existing?.messages ?? 0) + 1,
      updatedAt: new Date(now),
    });
  }
}

export async function createUsageService(config: AppConfig, log: Logger): Promise<UsageService> {
  const windowMs = config.USAGE_WINDOW_HOURS * 3_600_000;
  if (config.MONGODB_URI) return new MongoUsageService(await getMongo(config, log), config.USAGE_LIMIT_TOKENS, windowMs);
  return new MemoryUsageService(config.USAGE_LIMIT_TOKENS, windowMs);
}
