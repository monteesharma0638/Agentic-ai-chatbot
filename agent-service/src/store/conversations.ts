import type { ConversationRecord } from '../agent/types.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface ConversationStore {
  get(key: string): Promise<ConversationRecord | null>;
  set(key: string, record: ConversationRecord): Promise<void>;
  delete(key: string): Promise<void>;
  close?(): Promise<void>;
}

/** Conversations are namespaced by user so one user can never load another's chat. */
export function conversationKey(userId: string, conversationId: string): string {
  return `mfchat:conv:${userId}:${conversationId}`;
}

/** Single-instance store. Use Redis when running more than one agent instance. */
export class MemoryStore implements ConversationStore {
  private readonly map = new Map<string, { record: ConversationRecord; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000,
  ) {}

  async get(key: string): Promise<ConversationRecord | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return structuredClone(hit.record);
  }

  async set(key: string, record: ConversationRecord): Promise<void> {
    this.map.delete(key);
    this.map.set(key, { record: structuredClone(record), expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class RedisStore implements ConversationStore {
  private constructor(
    private readonly redis: import('ioredis').Redis,
    private readonly ttlSeconds: number,
  ) {}

  static async connect(url: string, ttlMs: number, log: Logger): Promise<RedisStore> {
    const { Redis } = await import('ioredis');
    const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
    redis.on('error', (err) => log.error({ err: err.message }, 'Redis error'));
    await redis.connect();
    log.info('Conversation store: Redis');
    return new RedisStore(redis, Math.ceil(ttlMs / 1000));
  }

  async get(key: string): Promise<ConversationRecord | null> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as ConversationRecord) : null;
  }

  async set(key: string, record: ConversationRecord): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'EX', this.ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/** The subset of Vercel's RuntimeCache used here (lets tests pass a fake). */
export interface KeyValueCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number; name?: string }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Vercel Runtime Cache: shared by every function instance in a region, with a
 * TTL and nothing to set up. Entries can be evicted early when the cache is
 * full, so a long-idle chat may lose its earlier context. Use Redis
 * (REDIS_URL) if conversations must be kept reliably.
 */
export class VercelRuntimeCacheStore implements ConversationStore {
  constructor(
    private readonly cache: KeyValueCache,
    private readonly ttlSeconds: number,
  ) {}

  static async create(ttlMs: number, log: Logger): Promise<VercelRuntimeCacheStore> {
    const { getCache } = await import('@vercel/functions');
    log.info('Conversation store: Vercel Runtime Cache');
    return new VercelRuntimeCacheStore(getCache({ namespace: 'mfchat' }), Math.ceil(ttlMs / 1000));
  }

  async get(key: string): Promise<ConversationRecord | null> {
    return ((await this.cache.get(key)) as ConversationRecord | null | undefined) ?? null;
  }

  async set(key: string, record: ConversationRecord): Promise<void> {
    // A fixed name keeps user ids out of Vercel's cache observability.
    await this.cache.set(key, record, { ttl: this.ttlSeconds, name: 'conversation' });
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(key);
  }
}

/**
 * Picks the store from CONVERSATION_STORE. "auto" means: Redis when REDIS_URL
 * is set, Vercel Runtime Cache when running on Vercel, otherwise memory.
 */
export async function createConversationStore(config: AppConfig, log: Logger): Promise<ConversationStore> {
  const ttlMs = config.CONVERSATION_TTL_HOURS * 3_600_000;
  const kind =
    config.CONVERSATION_STORE === 'auto'
      ? config.REDIS_URL
        ? 'redis'
        : config.VERCEL
          ? 'vercel'
          : 'memory'
      : config.CONVERSATION_STORE;

  switch (kind) {
    case 'redis':
      if (!config.REDIS_URL) throw new Error('CONVERSATION_STORE=redis requires REDIS_URL');
      return RedisStore.connect(config.REDIS_URL, ttlMs, log);
    case 'vercel':
      return VercelRuntimeCacheStore.create(ttlMs, log);
    default:
      log.info('Conversation store: in-memory (lost on restart; set REDIS_URL to persist)');
      return new MemoryStore(ttlMs);
  }
}
