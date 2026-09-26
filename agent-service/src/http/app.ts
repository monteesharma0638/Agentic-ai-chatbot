import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { MfAgent } from '../agent/agent.js';
import { ChatBodySchema, type AgentEvent, type ChatUser } from '../agent/types.js';
import { signUserToken, verifyUserToken } from '../auth/userToken.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { McpHub } from '../mcp/hub.js';
import { conversationKey, type ConversationStore } from '../store/conversations.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '../../public');
const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Fixed-window counter keyed by user id or IP. */
function createRateLimiter(perMinute: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      if (windows.size > 20_000) {
        for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
      }
      return true;
    }
    return ++w.count <= perMinute;
  };
}

function parseTrustProxy(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

declare module 'express-serve-static-core' {
  interface Request {
    chatUser?: ChatUser;
  }
}

export function createApp(deps: {
  agent: MfAgent;
  hub: McpHub;
  store: ConversationStore;
  config: AppConfig;
  log: Logger;
}) {
  const { agent, hub, store, config, log } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(config.TRUST_PROXY));

  // ---------- CORS (browser → this service directly) ----------
  const allowedOrigins = new Set(config.ALLOWED_ORIGINS);
  if (allowedOrigins.size === 0) log.warn('ALLOWED_ORIGINS is empty — only same-origin pages (e.g. the playground) can use the API');
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Visitor-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    } else if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return void res.status(403).json({ error: 'origin_not_allowed' });
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });
  app.use('/api', express.json({ limit: '32kb' }));

  // ---------- identity ----------
  const identify = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      if (!config.WIDGET_TOKEN_SECRET) return void res.status(401).json({ error: 'tokens_not_enabled' });
      const result = verifyUserToken(auth.slice(7).trim(), config.WIDGET_TOKEN_SECRET);
      if (!result.ok) {
        return void res.status(401).json({
          error: result.reason === 'expired' ? 'token_expired' : 'invalid_token',
          message: 'Your session has expired. Please refresh the page to keep chatting.',
        });
      }
      const { uid, name, risk } = result.claims;
      req.chatUser = { id: uid, name, risk_profile: risk, guest: false };
      return next();
    }
    const visitor = req.header('x-visitor-id');
    if (config.ALLOW_ANONYMOUS && visitor && VISITOR_ID.test(visitor)) {
      req.chatUser = { id: `guest:${visitor}`, guest: true };
      return next();
    }
    res.status(401).json({ error: 'auth_required', message: 'Please sign in to use the assistant.' });
  };

  const allowUser = createRateLimiter(config.RATE_LIMIT_PER_MINUTE);
  const allowIp = createRateLimiter(config.RATE_LIMIT_PER_IP_PER_MINUTE);

  const parseChat = (req: Request, res: Response) => {
    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'invalid_request',
        message: 'Invalid request.',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return null;
    }
    if (parsed.data.message.length > config.MAX_MESSAGE_CHARS) {
      res.status(422).json({ error: 'message_too_long', message: `Please keep messages under ${config.MAX_MESSAGE_CHARS} characters.` });
      return null;
    }
    if (!allowUser(req.chatUser!.id) || !allowIp(`ip:${req.ip}`)) {
      res.status(429).json({ error: 'rate_limited', message: "You're sending messages too quickly. Please wait a moment." });
      return null;
    }
    return {
      message: parsed.data.message,
      conversationId: parsed.data.conversation_id,
      context: parsed.data.context,
      user: req.chatUser!,
    };
  };

  /** Aborts the agent (and pending Gemini/MCP calls) if the browser goes away. */
  const abortOnClose = (res: Response) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  };

  // ---------- routes ----------
  app.get('/health', async (_req, res) => {
    // Reconnects to any MCP server that was down (e.g. started after the agent).
    await hub.listTools().catch(() => undefined);
    const servers = hub.status();
    const ok = servers.every((s) => s.connected);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', model: config.GEMINI_MODEL, mcp: servers });
  });

  app.post('/api/chat/stream', identify, async (req, res) => {
    const input = parseChat(req, res);
    if (!input) return;
    const signal = abortOnClose(res);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event: AgentEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    try {
      for await (const event of agent.chat(input, signal)) {
        if (signal.aborted) break;
        send(event);
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  /** Non-streaming variant (mobile apps, server-side callers, testing). */
  app.post('/api/chat', identify, async (req, res) => {
    const input = parseChat(req, res);
    if (!input) return;
    const signal = abortOnClose(res);
    const tools: { name: string; ok: boolean; ms: number }[] = [];
    const charts: unknown[] = [];
    for await (const event of agent.chat(input, signal)) {
      if (event.type === 'tool_end') tools.push({ name: event.name, ok: event.ok, ms: event.ms });
      else if (event.type === 'chart') charts.push(event.chart);
      else if (event.type === 'error') {
        const status = { busy: 409, rate_limited: 429, blocked: 200 }[event.code] ?? 502;
        return void res.status(status).json({ error: event.code, message: event.message });
      } else if (event.type === 'done') {
        return void res.json({
          conversation_id: event.conversation_id,
          reply: event.reply,
          charts,
          tools,
          model: event.model,
          usage: event.usage,
        });
      }
    }
    if (!res.headersSent) res.status(499).end();
  });

  const conversationKeyFor = (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!CONVERSATION_ID.test(id)) {
      res.status(422).json({ error: 'invalid_conversation_id' });
      return null;
    }
    return conversationKey(req.chatUser!.id, id);
  };

  app.get('/api/conversations/:id', identify, async (req, res) => {
    const key = conversationKeyFor(req, res);
    if (!key) return;
    const record = await store.get(key);
    if (!record) return void res.status(404).json({ error: 'not_found' });
    res.json({ conversation_id: record.id, messages: record.transcript, updated_at: record.updatedAt });
  });

  app.delete('/api/conversations/:id', identify, async (req, res) => {
    const key = conversationKeyFor(req, res);
    if (!key) return;
    await store.delete(key);
    res.status(204).end();
  });

  // ---------- widget script ----------
  const embedPath = resolve(PUBLIC_DIR, 'embed.js');
  app.get('/embed.js', (req, res) => {
    if (!existsSync(embedPath)) {
      return void res.status(503).type('text/plain').send('// embed.js not built yet: run `npm run build -w widget`');
    }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Vary', 'Accept-Encoding');
    const gzPath = `${embedPath}.gz`;
    // Only serve the pre-compressed copy if it's at least as new as embed.js (never a stale bundle).
    const gzFresh = existsSync(gzPath) && statSync(gzPath).mtimeMs >= statSync(embedPath).mtimeMs;
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && gzFresh) {
      res.setHeader('Content-Encoding', 'gzip');
      return void res.sendFile(gzPath, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
    }
    res.sendFile(embedPath);
  });

  // ---------- development playground ----------
  if (config.ENABLE_PLAYGROUND) {
    app.get('/', (_req, res) => res.redirect('/playground'));
    app.get('/playground', (_req, res) => res.sendFile(resolve(PUBLIC_DIR, 'playground.html')));
    /** Mints a signed user token exactly like the Blade snippet does. Dev only. */
    app.get('/dev/token', (req, res) => {
      if (!config.WIDGET_TOKEN_SECRET) return void res.json({ token: null, note: 'WIDGET_TOKEN_SECRET not set; guest mode only' });
      const uid = String(req.query.uid ?? 'demo-user').slice(0, 64);
      const name = req.query.name ? String(req.query.name).slice(0, 60) : undefined;
      res.json({ token: signUserToken({ uid, name, exp: Math.floor(Date.now() / 1000) + 12 * 3600 }, config.WIDGET_TOKEN_SECRET) });
    });
    log.info(`Playground enabled at http://${config.HOST}:${config.PORT}/playground`);
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: 'payload_too_large' });
    log.error({ err: err.message }, 'unhandled error');
    if (!res.headersSent) res.status(err.status ?? 500).json({ error: 'internal_error' });
  });

  return app;
}
