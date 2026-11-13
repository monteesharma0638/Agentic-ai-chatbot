import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { conversationKey, type ConversationStore } from '../store/conversations.js';
import type { UsageService } from '../usage/usage.js';

const USER_ID = /^[A-Za-z0-9_:.-]{1,80}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Server-to-server API: lets another backend (not the browser) read a user's
 * chats and token usage. Guarded by a single shared key in the `X-Api-Key`
 * header — the browser never sees it and never calls these routes.
 */
export function createInternalRouter(deps: { store: ConversationStore; usage: UsageService; config: AppConfig; log: Logger }): Router {
  const { store, usage, config } = deps;
  const router = express.Router();
  const expected = config.SERVICE_API_KEY ? Buffer.from(config.SERVICE_API_KEY) : null;

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!expected) return void res.status(503).json({ error: 'service_api_disabled', message: 'Set SERVICE_API_KEY to enable this API.' });
    const given = Buffer.from(req.header('x-api-key') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return void res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Api-Key.' });
    }
    next();
  });

  const userId = (req: Request, res: Response): string | null => {
    const id = String(req.params.userId);
    if (!USER_ID.test(id)) {
      res.status(422).json({ error: 'invalid_user_id' });
      return null;
    }
    return id;
  };

  // List a user's conversations (newest first), for a history panel on the other server.
  router.get('/users/:userId/conversations', async (req, res) => {
    const id = userId(req, res);
    if (!id) return;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const before = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const page = await store.list(id, { limit, before });
    res.json(page);
  });

  // Fetch one conversation's messages. 404 whether it's missing or owned by someone else (don't reveal which).
  router.get('/users/:userId/conversations/:conversationId', async (req, res) => {
    const id = userId(req, res);
    if (!id) return;
    const cid = String(req.params.conversationId);
    if (!CONVERSATION_ID.test(cid)) return void res.status(422).json({ error: 'invalid_conversation_id' });
    const record = await store.get(conversationKey(id, cid));
    if (!record) return void res.status(404).json({ error: 'not_found' });
    res.json({ conversation_id: record.id, messages: record.transcript, created_at: record.createdAt, updated_at: record.updatedAt });
  });

  // A user's token usage (same shape the quota gate uses internally).
  router.get('/users/:userId/usage', async (req, res) => {
    const id = userId(req, res);
    if (!id) return;
    res.json(await usage.check(id));
  });

  return router;
}
