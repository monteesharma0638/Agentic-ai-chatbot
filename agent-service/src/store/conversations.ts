import type { ConversationRecord } from '../agent/types.js';
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
