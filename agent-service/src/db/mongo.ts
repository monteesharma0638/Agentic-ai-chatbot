import type { Collection, Db, MongoClient } from 'mongodb';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ConversationRecord } from '../agent/types.js';

/** One stored conversation. `_id` is `${userId}:${conversationId}` so a user can never read another's chat. */
export interface ConversationDoc extends ConversationRecord {
  _id: string;
  /** First user message, for the history list. */
  title?: string;
  /** Last assistant reply (trimmed), for the history list. */
  preview?: string;
}

/** Per-user token usage: a running total for the current window plus an all-time figure. */
export interface UsageDoc {
  _id: string; // userId
  used: number; // tokens in the current window
  windowStart: Date;
  lifetimeTokens: number;
  messages: number;
  updatedAt: Date;
}

export interface Mongo {
  client: MongoClient;
  db: Db;
  conversations: Collection<ConversationDoc>;
  usage: Collection<UsageDoc>;
  close(): Promise<void>;
}

/**
 * A single MongoClient per process, reused by every request (and, on Vercel, by
 * every request a warm function instance serves). The driver pools connections,
 * so this must not be created per request.
 */
let shared: Promise<Mongo> | null = null;

export function getMongo(config: AppConfig, log: Logger): Promise<Mongo> {
  shared ??= connect(config, log).catch((err) => {
    shared = null; // let the next request retry instead of caching a failed connection
    throw err;
  });
  return shared;
}

async function connect(config: AppConfig, log: Logger): Promise<Mongo> {
  if (!config.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(config.MONGODB_URI, { retryWrites: true });
  await client.connect();
  const db = client.db(config.MONGODB_DB);
  const conversations = db.collection<ConversationDoc>('conversations');
  const usage = db.collection<UsageDoc>('usage');

  // Lists a user's chats newest-first; cheap to create and idempotent.
  await conversations.createIndex({ userId: 1, updatedAt: -1 }).catch((err) => log.warn({ err: err.message }, 'index create failed'));

  log.info(`MongoDB connected (db ${config.MONGODB_DB})`);
  return {
    client,
    db,
    conversations,
    usage,
    async close() {
      shared = null;
      await client.close();
    },
  };
}
