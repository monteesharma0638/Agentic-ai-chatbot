import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MfAgent, type ModelClient } from '../src/agent/agent.js';
import { compactHistory } from '../src/agent/history.js';
import { sanitizeSchema } from '../src/agent/schema.js';
import type { AgentEvent, ChatUser } from '../src/agent/types.js';
import { signUserToken, verifyUserToken } from '../src/auth/userToken.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { McpHub } from '../src/mcp/hub.js';
import { DemoPortfolioProvider } from '../src/portfolio/providers.js';
import {
  createConversationStore,
  MemoryStore,
  resolveStore,
  UpstashStore,
  VercelRuntimeCacheStore,
} from '../src/store/conversations.js';

const log = pino({ level: 'silent' });

type Step = (params: GenerateContentParameters) => Part[] | Error;

/** Scripted stand-in for Gemini: each call pops the next step and streams its parts. */
class FakeModel implements ModelClient {
  calls: GenerateContentParameters[] = [];
  constructor(private steps: Step[]) {}
  queue(...steps: Step[]) {
    this.steps.push(...steps);
  }
  async generateContentStream(params: GenerateContentParameters) {
    this.calls.push(structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }));
    const step = this.steps.shift();
    if (!step) throw new Error('FakeModel: no more scripted steps');
    const out = step(params);
    if (out instanceof Error) throw out;
    return (async function* () {
      for (const part of out) {
        yield { candidates: [{ content: { role: 'model', parts: [part] } }] } as unknown as GenerateContentResponse;
      }
      yield {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
      } as unknown as GenerateContentResponse;
    })();
  }
}

const lastContent = (p: GenerateContentParameters) => (p.contents as Content[]).at(-1)!;
const functionResponse = (p: GenerateContentParameters, i = 0) => lastContent(p).parts![i].functionResponse!;
const declaredTools = (p: GenerateContentParameters) =>
  (p.config!.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((d) => d.name);

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const config = loadConfig({
  GEMINI_API_KEY: 'test',
  GEMINI_MODEL: 'primary-model',
  GEMINI_FALLBACK_MODEL: 'fallback-model',
  WIDGET_TOKEN_SECRET: SECRET,
  ALLOW_ANONYMOUS: 'true',
  ALLOWED_ORIGINS: 'https://app.example.com',
  RATE_LIMIT_PER_MINUTE: '100',
});

const user = (id: string, extra: Partial<ChatUser> = {}): ChatUser => ({ id, guest: false, ...extra });

let hub: McpHub;

beforeAll(async () => {
  hub = new McpHub(
    [{ name: 'india-mf', transport: 'stdio', command: 'node', args: ['--import', 'tsx', '../mcp-server/src/index.ts', '--stdio'] }],
    log,
  );
  await hub.init();
}, 60_000);

afterAll(async () => {
  await hub?.close();
});

describe('schema sanitizer', () => {
  it('keeps Gemini-supported keywords only', () => {
    const out = sanitizeSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        code: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991, description: 'x' },
        q: { type: 'string', minLength: 2, default: 'a' },
        type: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['code'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        code: { type: 'integer', minimum: 0, description: 'x' },
        q: { type: 'string' },
        type: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['code'],
    });
  });
});

describe('history compaction', () => {
  const turn = (q: string, a: string): Content[] => [
    { role: 'user', parts: [{ text: q }] },
    { role: 'model', parts: [{ functionCall: { name: 'search_funds', args: { query: q } }, thoughtSignature: 'sig' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'search_funds', response: { result: 'big' } } }] },
    { role: 'model', parts: [{ text: a }] },
  ];

  it('drops old turns and strips tool traffic from older ones', () => {
    const history = [...turn('q1', 'a1'), ...turn('q2', 'a2'), ...turn('q3', 'a3')];
    expect(compactHistory(history, 2, 1)).toEqual([
      { role: 'user', parts: [{ text: 'q2' }] },
      { role: 'model', parts: [{ text: 'a2' }] },
      ...turn('q3', 'a3'),
    ]);
  });
});

describe('agent loop (fake Gemini + real MCP server)', () => {
  it('searches, fetches NAV history, streams an answer and emits a chart', async () => {
    const model = new FakeModel([
      () => [{ functionCall: { id: 'c1', name: 'search_funds', args: { query: 'parag parikh flexi cap', limit: 2 } }, thoughtSignature: 'sig-1' }],
      (p) => {
        const res = functionResponse(p);
        expect(res.id).toBe('c1');
        expect(JSON.stringify(res.response)).toContain('122639');
        // Signed model turn must be sent back unchanged.
        expect((p.contents as Content[]).at(-2)!.parts![0].thoughtSignature).toBe('sig-1');
        return [{ functionCall: { id: 'c2', name: 'get_nav_history', args: { scheme_code: 122639, from_date: '2025-01-01' } } }];
      },
      (p) => {
        expect(JSON.stringify(functionResponse(p).response)).toContain('"points"');
        return [{ text: 'Parag Parikh Flexi Cap ' }, { text: 'NAV is shown in the chart.' }];
      },
    ]);
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config, log });
    const events = await collect(agent.chat({ message: 'How has PPFAS flexi cap done?', user: user('u1') }));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('meta');
    expect(types).toContain('chart');
    expect(types.at(-1)).toBe('done');
    const done = events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(done.reply).toBe('Parag Parikh Flexi Cap NAV is shown in the chart.');
    expect(done.steps).toBe(3);
    expect(done.usage.total_tokens).toBe(360);
    expect(events.filter((e) => e.type === 'tool_end').every((e) => (e as { ok: boolean }).ok)).toBe(true);

    const first = model.calls[0];
    expect(first.model).toBe('primary-model');
    expect(declaredTools(first)).toContain('calculate_sip_returns');
    expect(declaredTools(first)).not.toContain('get_my_portfolio'); // no portfolio source configured
    expect(String(first.config!.systemInstruction)).toContain('SEBI');
  }, 60_000);

  it('keeps conversation memory between turns, per user', async () => {
    const store = new MemoryStore(60_000);
    const model = new FakeModel([() => [{ text: 'Hello!' }], () => [{ text: 'Still here.' }]]);
    const agent = new MfAgent({ model, hub, store, config, log });
    const e1 = await collect(agent.chat({ message: 'hi', user: user('u2') }));
    const conversationId = (e1[0] as { conversation_id: string }).conversation_id;
    await collect(agent.chat({ message: 'you there?', conversationId, user: user('u2') }));
    expect((model.calls[1].contents as Content[]).map((c) => c.parts![0].text)).toEqual(['hi', 'Hello!', 'you there?']);

    // Another user reusing the id gets a fresh conversation.
    const other = new FakeModel([() => [{ text: 'fresh' }]]);
    await collect(new MfAgent({ model: other, hub, store, config, log }).chat({ message: 'x', conversationId, user: user('intruder') }));
    expect((other.calls[0].contents as Content[]).length).toBe(1);
  });

  it("loads the signed-in user's portfolio from the provider, never for guests", async () => {
    const portfolio = new DemoPortfolioProvider();
    const model = new FakeModel([
      (p) => {
        expect(declaredTools(p)).toContain('get_my_portfolio');
        return [{ functionCall: { name: 'get_my_portfolio', args: {} } }];
      },
      (p) => {
        const response = functionResponse(p).response as { result: { total_value: number; holdings: unknown[]; portfolio_xirr_pct?: number } };
        expect(response.result.holdings).toHaveLength(3);
        expect(response.result.total_value).toBeGreaterThan(0);
        return [{ text: 'Your portfolio is worth …' }];
      },
    ]);
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config, log, portfolio });
    const events = await collect(agent.chat({ message: 'How is my portfolio doing?', user: user('u3', { name: 'Asha' }) }));
    expect(events.at(-1)!.type).toBe('done');

    const guestModel = new FakeModel([() => [{ text: 'Please sign in.' }]]);
    await collect(
      new MfAgent({ model: guestModel, hub, store: new MemoryStore(60_000), config, log, portfolio }).chat({
        message: 'my portfolio?',
        user: { id: 'guest:abc', guest: true },
      }),
    );
    expect(declaredTools(guestModel.calls[0])).not.toContain('get_my_portfolio');
  }, 30_000);

  it('falls back to the secondary model when the primary is overloaded', async () => {
    const overloaded = Object.assign(new Error('overloaded'), { status: 503 });
    const model = new FakeModel([() => overloaded, () => [{ text: 'ok from fallback' }]]);
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config, log });
    const done = (await collect(agent.chat({ message: 'hi', user: user('u4') }))).at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(done.model).toBe('fallback-model');
    expect(done.reply).toBe('ok from fallback');
  });

  it('falls back when the 503 surfaces on the first stream read (real SDK behaviour)', async () => {
    const calls: string[] = [];
    const model: ModelClient = {
      async generateContentStream(params) {
        calls.push(params.model);
        if (params.model === 'primary-model') {
          return (async function* () {
            throw Object.assign(new Error('got status: UNAVAILABLE. high demand'), { status: 503 });
          })();
        }
        return (async function* () {
          yield { candidates: [{ content: { role: 'model', parts: [{ text: 'fallback answer' }] }, finishReason: 'STOP' }] } as unknown as GenerateContentResponse;
        })();
      },
    };
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config, log });
    const done = (await collect(agent.chat({ message: 'hi', user: user('u6') }))).at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(calls).toEqual(['primary-model', 'fallback-model']);
    expect(done.type).toBe('done');
    expect(done.reply).toBe('fallback answer');
  });

  it('rewinds partial text and retries on the next model when a stream dies mid-answer', async () => {
    const calls: string[] = [];
    const chunk = (text: string, finish?: string) =>
      ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finish && { finishReason: finish }) }] }) as unknown as GenerateContentResponse;
    const model: ModelClient = {
      async generateContentStream(params) {
        calls.push(params.model);
        if (params.model === 'primary-model') {
          return (async function* () {
            yield chunk('| Scheme | 3Y CAGR |');
            throw Object.assign(new Error('got status: UNAVAILABLE. high demand'), { status: 503 });
          })();
        }
        return (async function* () {
          yield chunk('Complete answer from fallback.', 'STOP');
        })();
      },
    };
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config, log });
    const events = await collect(agent.chat({ message: 'top small caps', user: user('u7') }));
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'rewind', 'delta', 'done']);
    expect(events[2]).toEqual({ type: 'rewind', reply: '' });
    expect((events.at(-1) as Extract<AgentEvent, { type: 'done' }>).reply).toBe('Complete answer from fallback.');

    // The failed model cools down: the next request goes to the fallback first.
    calls.length = 0;
    await collect(agent.chat({ message: 'again', user: user('u7') }));
    expect(calls[0]).toBe('fallback-model');
  });

  it('fails over when a model stalls without sending anything', async () => {
    const stallConfig = { ...config, MODEL_STALL_TIMEOUT_MS: 3000 };
    const calls: string[] = [];
    const model: ModelClient = {
      async generateContentStream(params) {
        calls.push(params.model);
        if (params.model === 'primary-model') {
          return (async function* () {
            await new Promise((r) => setTimeout(r, 60_000)); // never answers in time
          })() as AsyncGenerator<GenerateContentResponse>;
        }
        return (async function* () {
          yield { candidates: [{ content: { role: 'model', parts: [{ text: 'fast reply' }] }, finishReason: 'STOP' }] } as unknown as GenerateContentResponse;
        })();
      },
    };
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config: stallConfig, log });
    const started = Date.now();
    const done = (await collect(agent.chat({ message: 'hi', user: user('u8') }))).at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(done.reply).toBe('fast reply');
    expect(calls).toEqual(['primary-model', 'fallback-model']);
    expect(Date.now() - started).toBeLessThan(6000);
  }, 15_000);

  it('reports tool errors to the model instead of crashing', async () => {
    const model = new FakeModel([
      () => [{ functionCall: { name: 'get_fund_overview', args: { scheme_code: 999999999 } } }],
      (p) => {
        expect(functionResponse(p).response).toHaveProperty('error');
        return [{ text: 'I could not find that scheme.' }];
      },
    ]);
    const agent = new MfAgent({ model, hub, store: new MemoryStore(60_000), config, log });
    const events = await collect(agent.chat({ message: 'fund 999999999?', user: user('u5') }));
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false });
    expect(events.at(-1)!.type).toBe('done');
  }, 30_000);
});

describe('deployment building blocks (Vercel / VPS)', () => {
  it('runs the MCP server in-process (single-function deployments)', async () => {
    const inproc = new McpHub([{ name: 'india-mf', transport: 'inprocess' }], log);
    await inproc.init();
    const tools = await inproc.listTools();
    expect(tools).toHaveLength(14);
    const res = await inproc.callTool('get_nav_on_date', { fund: 'parag parikh flexi cap', dates: ['2020-03-23'] }, { timeoutMs: 30_000 });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.data)).toContain('20.2032');
    await inproc.close();
  }, 60_000);

  it('stores conversations in a Vercel Runtime Cache with a TTL and no user id in the entry name', async () => {
    const calls: { key: string; options?: { ttl?: number; name?: string } }[] = [];
    const data = new Map<string, unknown>();
    const fakeCache = {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: unknown, options?: { ttl?: number; name?: string }) => {
        calls.push({ key, options });
        data.set(key, structuredClone(value));
      },
      delete: async (key: string) => void data.delete(key),
    };
    const store = new VercelRuntimeCacheStore(fakeCache, 86_400);
    const record = { id: 'c1', userId: '42', contents: [], transcript: [], createdAt: 'x', updatedAt: 'x' };
    expect(await store.get('k')).toBeNull();
    await store.set('k', record);
    expect(await store.get('k')).toEqual(record);
    expect(calls[0].options).toEqual({ ttl: 86_400, name: 'conversation' });
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });

  it('stores conversations in Upstash Redis (REST) with a TTL', async () => {
    const data = new Map<string, unknown>();
    const setCalls: unknown[] = [];
    const fake = {
      get: async <T>(key: string) => (data.get(key) as T) ?? null,
      set: async (key: string, value: unknown, opts: { ex: number }) => {
        setCalls.push(opts);
        data.set(key, structuredClone(value));
        return 'OK';
      },
      del: async (key: string) => Number(data.delete(key)),
    };
    const store = new UpstashStore(fake, 3600);
    const record = { id: 'c1', userId: '42', contents: [], transcript: [], createdAt: 'x', updatedAt: 'x' };
    await store.set('k', record);
    expect(await store.get('k')).toEqual(record);
    expect(setCalls[0]).toEqual({ ex: 3600 });
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
    expect(store.kind).toBe('upstash');
  });

  it('detects every Redis variable name the Vercel ⇄ Upstash integration may add', () => {
    const base = { GEMINI_API_KEY: 'x', ALLOW_ANONYMOUS: 'true', VERCEL: '1' };
    const kind = (env: Record<string, string>) => resolveStore(loadConfig({ ...base, ...env })).kind;
    expect(kind({})).toBe('vercel');
    expect(kind({ KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' })).toBe('upstash');
    expect(kind({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' })).toBe('upstash');
    expect(kind({ KV_URL: 'rediss://default:p@x.upstash.io:6379' })).toBe('redis');
    expect(kind({ REDIS_URL: 'redis://127.0.0.1:6379' })).toBe('redis');
    expect(kind({ REDIS_URL: '' })).toBe('vercel'); // empty value from a copied .env.example
    expect(resolveStore(loadConfig({ ...base, KV_URL: 'rediss://k' })).redisUrl).toBe('rediss://k');
  });

  it('allows a public playground in production, except alongside real portfolio data', () => {
    const base = { GEMINI_API_KEY: 'x', ALLOW_ANONYMOUS: 'true', VERCEL: '1', VERCEL_ENV: 'production', ENABLE_PLAYGROUND: 'true' };
    expect(loadConfig(base).ENABLE_PLAYGROUND).toBe(true);
    expect(loadConfig({ ...base, PORTFOLIO_SOURCE: 'demo' }).ENABLE_PLAYGROUND).toBe(true);
    const mysql = { ...base, PORTFOLIO_SOURCE: 'mysql' };
    expect(() => loadConfig(mysql)).toThrow(/any user's portfolio/);
    expect(loadConfig({ ...mysql, PLAYGROUND_PASSWORD: 'long-enough-password' }).ENABLE_PLAYGROUND).toBe(true);
    expect(() => loadConfig({ ...base, PLAYGROUND_PASSWORD: 'short' })).toThrow(/12 characters/);
  });

  it('serves a public playground when no password is set', async () => {
    const pgConfig = loadConfig({
      GEMINI_API_KEY: 'x',
      WIDGET_TOKEN_SECRET: SECRET,
      VERCEL: '1',
      VERCEL_ENV: 'production',
      ENABLE_PLAYGROUND: 'true',
    });
    const store = new MemoryStore(60_000);
    const agent = new MfAgent({ model: new FakeModel([]), hub, store, config: pgConfig, log });
    const server = createApp({ agent, hub, store, config: pgConfig, log }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/playground`)).status).toBe(200);
      const { token } = (await (await fetch(`${url}/dev/token?uid=1`)).json()) as { token: string };
      expect(verifyUserToken(token, SECRET).ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('protects the playground and test-token endpoint with a browser login', async () => {
    const pgConfig = loadConfig({
      GEMINI_API_KEY: 'x',
      WIDGET_TOKEN_SECRET: SECRET,
      VERCEL: '1',
      VERCEL_ENV: 'production',
      ENABLE_PLAYGROUND: 'true',
      PLAYGROUND_PASSWORD: 'long-enough-password',
    });
    const store = new MemoryStore(60_000);
    const agent = new MfAgent({ model: new FakeModel([]), hub, store, config: pgConfig, log });
    const server = createApp({ agent, hub, store, config: pgConfig, log }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const basic = (pw: string) => ({ Authorization: `Basic ${Buffer.from(`me:${pw}`).toString('base64')}` });
    try {
      const noAuth = await fetch(`${url}/playground`);
      expect(noAuth.status).toBe(401);
      expect(noAuth.headers.get('www-authenticate')).toContain('Basic');
      expect((await fetch(`${url}/playground`, { headers: basic('wrong-password-123') })).status).toBe(401);
      expect((await fetch(`${url}/playground`, { headers: basic('long-enough-password') })).status).toBe(200);
      expect((await fetch(`${url}/dev/token?uid=1`)).status).toBe(401);
      const token = (await (await fetch(`${url}/dev/token?uid=1`, { headers: basic('long-enough-password') })).json()) as { token: string };
      expect(verifyUserToken(token.token, SECRET).ok).toBe(true);
      expect(((await (await fetch(`${url}/health`)).json()) as { store: string }).store).toBe('memory');
    } finally {
      server.close();
    }
  });

  it('picks the conversation store from the environment', async () => {
    const base = { GEMINI_API_KEY: 'x', ALLOW_ANONYMOUS: 'true' };
    expect(await createConversationStore(loadConfig(base), log)).toBeInstanceOf(MemoryStore);
    expect(await createConversationStore(loadConfig({ ...base, VERCEL: '1' }), log)).toBeInstanceOf(VercelRuntimeCacheStore);
    expect(await createConversationStore(loadConfig({ ...base, VERCEL: '1', CONVERSATION_STORE: 'memory' }), log)).toBeInstanceOf(MemoryStore);
    // On Vercel, client IPs come from X-Forwarded-For.
    expect(loadConfig({ ...base, VERCEL: '1' }).TRUST_PROXY).toBe('true');
  });
});

describe('user tokens', () => {
  it('round-trips and rejects tampering / expiry', () => {
    const token = signUserToken({ uid: '42', name: 'Asha', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    expect(verifyUserToken(token, SECRET)).toEqual({ ok: true, claims: { uid: '42', name: 'Asha', exp: expect.any(Number) } });

    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: '1', exp: 9999999999 })).toString('base64url');
    expect(verifyUserToken(`${forged}.${sig}`, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyUserToken(`${payload}.${sig}`, 'another-secret-another-secret-another')).toMatchObject({ ok: false });
    expect(verifyUserToken(signUserToken({ uid: '42', exp: 1 }, SECRET), SECRET)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyUserToken('garbage', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a token minted by the PHP code used in the Blade snippet', () => {
    const php = [
      '$secret = $argv[1];',
      "$payload = rtrim(strtr(base64_encode(json_encode(['uid' => (string) 42, 'name' => 'Ásha Rao', 'exp' => time() + 43200])), '+/', '-_'), '=');",
      "echo $payload.'.'.hash_hmac('sha256', $payload, $secret);",
    ].join(' ');
    let token: string;
    try {
      token = execFileSync('php', ['-r', php, SECRET], { encoding: 'utf8' });
    } catch {
      console.warn('php not available; skipping PHP compatibility check');
      return;
    }
    expect(verifyUserToken(token.trim(), SECRET)).toMatchObject({ ok: true, claims: { uid: '42', name: 'Ásha Rao' } });
  });
});

describe('HTTP API', () => {
  let base: string;
  let close: () => void;
  const model = new FakeModel([]);
  const ORIGIN = 'https://app.example.com';
  const token = signUserToken({ uid: '42', name: 'Asha', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);

  beforeAll(async () => {
    const store = new MemoryStore(60_000);
    const agent = new MfAgent({ model, hub, store, config, log });
    const server = createApp({ agent, hub, store, config, log }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const post = (path: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });

  const sse = async (res: Response) =>
    (await res.text())
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => JSON.parse(b.split('\n')[1].slice(6)) as AgentEvent);

  it('answers CORS preflight only for allowed origins', async () => {
    const ok = await fetch(`${base}/api/chat/stream`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await fetch(`${base}/api/chat/stream`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });

  it('rejects bad tokens, missing identity and invalid bodies', async () => {
    expect((await post('/api/chat', { message: 'hi' }, { Authorization: 'Bearer abc.def' })).status).toBe(401);
    const expired = await post('/api/chat', { message: 'hi' }, { Authorization: `Bearer ${signUserToken({ uid: '42', exp: 1 }, SECRET)}` });
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: string }).error).toBe('token_expired');
    expect((await post('/api/chat', { message: 'hi' }, {})).status).toBe(401);
    expect((await post('/api/chat', {})).status).toBe(422);
    expect((await post('/api/chat', { message: 'hi', conversation_id: '../../etc' })).status).toBe(422);
  });

  it('streams SSE for a signed-in user and scopes history to that user', async () => {
    model.queue(() => [{ text: 'Namaste! ' }, { text: 'Ask me about funds.' }]);
    const res = await post('/api/chat/stream', { message: 'hello' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const events = await sse(res);
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'delta', 'done']);
    const id = (events[0] as { conversation_id: string }).conversation_id;

    const history = await fetch(`${base}/api/conversations/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await history.json()) as { messages: { text: string }[] };
    expect(body.messages.map((m) => m.text)).toEqual(['hello', 'Namaste! Ask me about funds.']);

    const otherToken = signUserToken({ uid: '7', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const other = await fetch(`${base}/api/conversations/${id}`, { headers: { Authorization: `Bearer ${otherToken}` } });
    expect(other.status).toBe(404);
  });

  it('supports guest mode with a visitor id', async () => {
    model.queue((p) => {
      expect(String(p.config!.systemInstruction)).toContain('guest');
      return [{ text: 'Hi guest' }];
    });
    const res = await post('/api/chat', { message: 'hello' }, { 'X-Visitor-Id': 'visitor_1234567890abcdef' });
    const body = (await res.json()) as { reply: string; conversation_id: string };
    expect(res.status).toBe(200);
    expect(body.reply).toBe('Hi guest');
    expect(body.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await post('/api/chat', { message: 'hello' }, { 'X-Visitor-Id': 'short' })).status).toBe(401);
  });

  it('serves the embeddable widget script', async () => {
    const res = await fetch(`${base}/embed.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('MfChat');
  });
});
