import type { ConversationRecord } from '../agent/types.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export type StoreKind = 'memory' | 'redis' | 'upstash' | 'vercel';

export interface ConversationStore {
  /** Shown by /health so you can confirm which store is live. */
  readonly kind: StoreKind;
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
  readonly kind = 'memory';
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

/** Redis over TCP (self-hosted Redis on a VPS, or any rediss:// URL). */
export class RedisStore implements ConversationStore {
  readonly kind = 'redis';

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

/** The subset of the Upstash REST client used here (lets tests pass a fake). */
export interface UpstashLikeClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts: { ex: number }): Promise<unknown>;
  del(key: string): Promise<number>;
}

/**
 * Upstash Redis over its HTTPS REST API: no connections to keep open, which
 * suits serverless functions. Credentials come from the Vercel ⇄ Upstash
 * integration (KV_REST_API_* or UPSTASH_REDIS_REST_*).
 */
export class UpstashStore implements ConversationStore {
  readonly kind = 'upstash';

  constructor(
    private readonly redis: UpstashLikeClient,
    private readonly ttlSeconds: number,
  ) {}

  static async create(url: string, token: string, ttlMs: number, log: Logger): Promise<UpstashStore> {
    const { Redis } = await import('@upstash/redis');
    log.info('Conversation store: Upstash Redis');
    return new UpstashStore(new Redis({ url, token }), Math.ceil(ttlMs / 1000));
  }

  async get(key: string): Promise<ConversationRecord | null> {
    return (await this.redis.get<ConversationRecord>(key)) ?? null;
  }

  async set(key: string, record: ConversationRecord): Promise<void> {
    await this.redis.set(key, record, { ex: this.ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
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
 * full, so a long-idle chat may lose its earlier context. Use Redis if
 * conversations must be kept reliably.
 */
export class VercelRuntimeCacheStore implements ConversationStore {
  readonly kind = 'vercel';

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

/** Which store CONVERSATION_STORE resolves to, and with which credentials. */
export function resolveStore(config: AppConfig): { kind: StoreKind; redisUrl?: string; rest?: { url: string; token: string } } {
  const restUrl = config.UPSTASH_REDIS_REST_URL || config.KV_REST_API_URL;
  const restToken = config.UPSTASH_REDIS_REST_TOKEN || config.KV_REST_API_TOKEN;
  const rest = restUrl && restToken ? { url: restUrl, token: restToken } : undefined;
  const redisUrl = config.REDIS_URL || config.KV_URL || undefined;

  const kind: StoreKind =
    config.CONVERSATION_STORE !== 'auto'
      ? config.CONVERSATION_STORE
      : rest
        ? 'upstash'
        : redisUrl
          ? 'redis'
          : config.VERCEL
            ? 'vercel'
            : 'memory';
  return { kind, redisUrl, rest };
}

export async function createConversationStore(config: AppConfig, log: Logger): Promise<ConversationStore> {
  const ttlMs = config.CONVERSATION_TTL_HOURS * 3_600_000;
  const { kind, redisUrl, rest } = resolveStore(config);

  switch (kind) {
    case 'upstash':
      if (!rest) throw new Error('CONVERSATION_STORE=upstash requires KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN');
      return UpstashStore.create(rest.url, rest.token, ttlMs, log);
    case 'redis':
      if (!redisUrl) throw new Error('CONVERSATION_STORE=redis requires REDIS_URL');
      return RedisStore.connect(redisUrl, ttlMs, log);
    case 'vercel':
      return VercelRuntimeCacheStore.create(ttlMs, log);
    default:
      log.info('Conversation store: in-memory (lost on restart; set REDIS_URL to persist)');
      return new MemoryStore(ttlMs);
  }
}
