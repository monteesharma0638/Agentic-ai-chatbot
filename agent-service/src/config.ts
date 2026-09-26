import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),

  /** Secret shared with the website that signs user tokens (min 32 chars). */
  WIDGET_TOKEN_SECRET: z.string().optional(),
  /** Allow chatting without a signed token (guests, identified by a random browser id). */
  ALLOW_ANONYMOUS: bool,
  /** Comma-separated origins allowed to call the API from the browser, e.g. https://app.example.com */
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)),
  /** Express "trust proxy" setting; set to 1 behind nginx / a load balancer so client IPs are correct. */
  TRUST_PROXY: z.string().default('loopback'),

  /** Set automatically by Vercel ("1") and its environment name (production / preview / development). */
  VERCEL: bool,
  VERCEL_ENV: z.string().optional(),

  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required (https://aistudio.google.com/apikey)'),
  /** Flash-Lite: lowest latency and the most generous free-tier quota. */
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  /** Tried in order when a model is overloaded (503), out of quota (429), unavailable or stalls. */
  GEMINI_FALLBACK_MODELS: list.default(['gemini-3.6-flash', 'gemini-3.8-flash']),
  /** minimal | low | medium | high — lower is faster and cheaper. Empty = model default. */
  GEMINI_THINKING_LEVEL: z.enum(['', 'minimal', 'low', 'medium', 'high']).default('low'),
  /** Abandon a model response that produces nothing for this long, and fail over. */
  MODEL_STALL_TIMEOUT_MS: z.coerce.number().int().min(3000).default(20_000),
  /** After a failure, a model is tried last for this many seconds. */
  MODEL_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().default(2048),

  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
  TOOL_TIMEOUT_MS: z.coerce.number().int().default(45_000),
  MCP_CONFIG: z.string().default('mcp.config.json'),
  /** Optional JSON override of the MCP config file (handy in containers). */
  MCP_SERVERS: z.string().optional(),

  /**
   * auto = Upstash Redis (REST) if its credentials are set, else Redis over TCP if REDIS_URL / KV_URL is set,
   * else Vercel Runtime Cache on Vercel, otherwise in-memory.
   */
  CONVERSATION_STORE: z.enum(['auto', 'memory', 'redis', 'upstash', 'vercel']).default('auto'),
  /** Redis over TCP, e.g. redis://127.0.0.1:6379 (VPS) or rediss://… (Upstash). */
  REDIS_URL: z.string().optional(),
  /** Names the Vercel ⇄ Upstash integration may add; picked up automatically. */
  KV_URL: z.string().optional(),
  KV_REST_API_URL: z.string().optional(),
  KV_REST_API_TOKEN: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  CONVERSATION_TTL_HOURS: z.coerce.number().default(24),
  /** Past user turns sent to the model. Older turns are dropped. */
  HISTORY_MAX_TURNS: z.coerce.number().int().default(12),
  /** Recent turns that keep full tool call/response detail; older turns keep text only. */
  HISTORY_FULL_TURNS: z.coerce.number().int().default(2),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(20),
  /** Per-IP limit across all users (protects guest mode). */
  RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().default(60),
  MAX_MESSAGE_CHARS: z.coerce.number().int().default(2000),

  APP_NAME: z.string().default('MF Invest'),
  ASSISTANT_NAME: z.string().default('Fundy'),
  ENABLE_PLAYGROUND: bool,
  /** Protects /playground and /dev/token with a browser login (any username). Required in production. */
  PLAYGROUND_PASSWORD: z.string().optional(),

  /** none | demo | mysql — source of the signed-in user's holdings for "my portfolio" questions. */
  PORTFOLIO_SOURCE: z.enum(['none', 'demo', 'mysql']).default('none'),
  PORTFOLIO_DB_URL: z.string().optional(),
  PORTFOLIO_HOLDINGS_SQL: z.string().optional(),
  PORTFOLIO_TRANSACTIONS_SQL: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Production on a VPS (NODE_ENV=production) or on Vercel's production environment.
 * On Vercel, don't set NODE_ENV=production yourself: npm would then skip the
 * dev dependencies the build needs.
 */
export function isProduction(cfg: Pick<AppConfig, 'NODE_ENV' | 'VERCEL_ENV'>): boolean {
  return cfg.NODE_ENV === 'production' || cfg.VERCEL_ENV === 'production';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const source = { ...env };
  // Older .env files used a single GEMINI_FALLBACK_MODEL.
  if (!source.GEMINI_FALLBACK_MODELS && source.GEMINI_FALLBACK_MODEL) source.GEMINI_FALLBACK_MODELS = source.GEMINI_FALLBACK_MODEL;
  // Vercel's edge sets X-Forwarded-For/Proto; trust it so rate limits see real client IPs.
  if (source.VERCEL && !source.TRUST_PROXY) source.TRUST_PROXY = 'true';
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.WIDGET_TOKEN_SECRET && cfg.WIDGET_TOKEN_SECRET.length < 32) {
    throw new Error('WIDGET_TOKEN_SECRET must be at least 32 characters.');
  }
  if (!cfg.WIDGET_TOKEN_SECRET && !cfg.ALLOW_ANONYMOUS) {
    throw new Error('Set WIDGET_TOKEN_SECRET (signed-in users) and/or ALLOW_ANONYMOUS=true (guests).');
  }
  if (cfg.PLAYGROUND_PASSWORD !== undefined && cfg.PLAYGROUND_PASSWORD.length > 0 && cfg.PLAYGROUND_PASSWORD.length < 12) {
    throw new Error('PLAYGROUND_PASSWORD must be at least 12 characters.');
  }
  // A public playground can mint a login token for any user id: never combine it with real portfolio data.
  if (isProduction(cfg) && cfg.ENABLE_PLAYGROUND && !cfg.PLAYGROUND_PASSWORD && cfg.PORTFOLIO_SOURCE === 'mysql') {
    throw new Error(
      'A playground without PLAYGROUND_PASSWORD would let anyone view any user\'s portfolio. ' +
        'Set PLAYGROUND_PASSWORD, turn the playground off, or use PORTFOLIO_SOURCE=none/demo.',
    );
  }
  return cfg;
}
