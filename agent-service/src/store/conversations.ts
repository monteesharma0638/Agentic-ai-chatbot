import type { ConversationRecord } from '../agent/types.js';
import type { AppConfig } from '../config.js';
import type { Mongo } from '../db/mongo.js';
import { getMongo } from '../db/mongo.js';
import type { Logger } from '../logger.js';

export type StoreKind = 'memory' | 'mongo';

/** One row of the history list (no transcript, so listing stays cheap). */
export interface ConversationSummary {
  conversation_id: string;
  title: string;
  preview: string;
  updated_at: string;
}

export interface ConversationPage {
  conversations: ConversationSummary[];
  /** Pass back as `before` to get the next page; null when there are no more. */
  next_cursor: string | null;
}

export interface ConversationStore {
  /** Shown by /health so you can confirm which store is live. */
  readonly kind: StoreKind;
  get(key: string): Promise<ConversationRecord | null>;
  set(key: string, record: ConversationRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Newest-first page of a user's conversations, for the widget and the server-to-server API. */
  list(userId: string, opts: { limit: number; before?: string }): Promise<ConversationPage>;
  close?(): Promise<void>;
}

/** Conversations are namespaced by user so one user can never load another's chat. */
export function conversationKey(userId: string, conversationId: string): string {
  return `mfchat:conv:${userId}:${conversationId}`;
}

function firstUserText(record: ConversationRecord): string {
  return record.transcript.find((m) => m.role === 'user')?.text.slice(0, 120) ?? '';
}

function lastAssistantText(record: ConversationRecord): string {
  return [...record.transcript].reverse().find((m) => m.role === 'assistant')?.text.slice(0, 160) ?? '';
}

/** Single-instance store for local dev and tests only (lost on restart; set MONGODB_URI to persist). */
export class MemoryStore implements ConversationStore {
  readonly kind = 'memory';
  private readonly map = new Map<string, { record: ConversationRecord; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 24 * 3_600_000,
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

  async list(userId: string, opts: { limit: number; before?: string }): Promise<ConversationPage> {
    const now = Date.now();
    const rows = [...this.map.values()]
      .filter((e) => e.expiresAt >= now && e.record.userId === userId && (!opts.before || e.record.updatedAt < opts.before))
      .map((e) => e.record)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, opts.limit);
    return {
      conversations: rows.map((r) => ({ conversation_id: r.id, title: firstUserText(r), preview: lastAssistantText(r), updated_at: r.updatedAt })),
      next_cursor: rows.length === opts.limit ? rows[rows.length - 1]!.updatedAt : null,
    };
  }
}

/** MongoDB: the persistent, shared store used in production. */
export class MongoConversationStore implements ConversationStore {
  readonly kind = 'mongo';
  constructor(private readonly mongo: Mongo) {}

  async get(key: string): Promise<ConversationRecord | null> {
    const doc = await this.mongo.conversations.findOne({ _id: key });
    if (!doc) return null;
    const { _id, title, preview, ...record } = doc;
    void _id;
    void title;
    void preview;
    return record;
  }

  async set(key: string, record: ConversationRecord): Promise<void> {
    // On upsert insert, `_id` comes from the filter — it must not be in the replacement document.
    await this.mongo.conversations.replaceOne(
      { _id: key },
      { ...record, title: firstUserText(record), preview: lastAssistantText(record) },
      { upsert: true },
    );
  }

  async delete(key: string): Promise<void> {
    await this.mongo.conversations.deleteOne({ _id: key });
  }

  async list(userId: string, opts: { limit: number; before?: string }): Promise<ConversationPage> {
    const rows = await this.mongo.conversations
      .find(
        { userId, ...(opts.before && { updatedAt: { $lt: opts.before } }) },
        { projection: { id: 1, title: 1, preview: 1, updatedAt: 1 }, sort: { updatedAt: -1 }, limit: opts.limit },
      )
      .toArray();
    return {
      conversations: rows.map((r) => ({ conversation_id: r.id, title: r.title ?? '', preview: r.preview ?? '', updated_at: r.updatedAt })),
      next_cursor: rows.length === opts.limit ? rows[rows.length - 1]!.updatedAt : null,
    };
  }
}

export async function createConversationStore(config: AppConfig, log: Logger): Promise<ConversationStore> {
  if (config.MONGODB_URI) return new MongoConversationStore(await getMongo(config, log));
  log.warn('Conversation store: in-memory (lost on restart; set MONGODB_URI to persist in MongoDB)');
  return new MemoryStore();
}
