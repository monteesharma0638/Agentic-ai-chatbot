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

  /** Secret shared with the website that signs user tokens; must match that signer (32+ chars recommended). */
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

  /** Service key the other server sends (header X-Api-Key) to read conversations/usage. Min 16 chars. */
  SERVICE_API_KEY: z.string().optional(),

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
   * MongoDB holds all chats and token usage, keyed by the user id from the JWT.
   * Required in production; when unset (local dev / tests) the service falls back to an in-memory store.
   */
  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().default('mfchat'),

  /** Per-user AI token budget per window. 0 (default) = no limit. */
  USAGE_LIMIT_TOKENS: z.coerce.number().int().min(0).default(0),
  /** Rolling window the budget resets over, in hours. */
  USAGE_WINDOW_HOURS: z.coerce.number().min(1).default(24),

  /** Past user turns sent to the model. Older turns are dropped. */
  HISTORY_MAX_TURNS: z.coerce.number().int().default(12),
  /** Recent turns that keep full tool call/response detail; older turns keep text only. */
  HISTORY_FULL_TURNS: z.coerce.number().int().default(2),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(20),
  /** Per-IP limit across all users (protects guest mode). */
  RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().default(60),
  MAX_MESSAGE_CHARS: z.coerce.number().int().default(2000),
  /**
   * Largest chat request body, in MB. A message may carry an attached image or PDF inside it, so this
   * is higher than the usual JSON limit. Keep it under your host's own body cap (Vercel is ~4.5 MB).
   */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(20).default(6),

  APP_NAME: z.string().default('MF Invest'),
  ASSISTANT_NAME: z.string().default('Fundy'),
  ENABLE_PLAYGROUND: bool,
  /** Protects /playground and /dev/token with a browser login (any username). Required in production. */
  PLAYGROUND_PASSWORD: z.string().optional(),
  /**
   * Playground only: a ready-made user JWT (e.g. a real host-app token). `/dev/token` serves it and the
   * identity layer trusts this exact string verbatim, without a signature check, so the real host-app token
   * can be used in the playground without putting the host's signing secret in this env. Active only while
   * ENABLE_PLAYGROUND is true (works on any deploy, including production) — turning the playground off for
   * launch disables it too. Leave it unset once real per-user tokens verify via WIDGET_TOKEN_SECRET.
   */
  PLAYGROUND_USER_TOKEN: z.string().optional(),

  /** none | demo | roborupee — source of the signed-in user's holdings for "my portfolio" questions. */
  PORTFOLIO_SOURCE: z.enum(['none', 'demo', 'roborupee']).default('none'),
  /** Base URL of the Robo Rupee admin API that serves holdings, e.g. https://admin.roborupee.com */
  ROBORUPEE_API_URL: z.string().url().optional(),
  /** Path of the holdings endpoint on that API. */
  ROBORUPEE_HOLDINGS_PATH: z.string().default('/api/holdings/get'),
  /**
   * Fallback bearer token for the holdings API, used only when the user's own token isn't forwarded
   * (single-tenant testing). In production each user's own JWT is forwarded instead — leave this unset.
   */
  ROBORUPEE_API_TOKEN: z.string().optional(),
  /** Timeout for a holdings API call, in ms. */
  ROBORUPEE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
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
    // Not fatal: WIDGET_TOKEN_SECRET must equal the host app's own token-signing secret to verify its JWTs,
    // and that secret may be shorter than 32 chars. A short HS256 secret is easier to brute-force, so warn.
    console.warn(
      `[config] WIDGET_TOKEN_SECRET is only ${cfg.WIDGET_TOKEN_SECRET.length} characters — it must match the secret ` +
        'your host app signs tokens with; 32+ characters is strongly recommended for HS256.',
    );
  }
  if (!cfg.WIDGET_TOKEN_SECRET && !cfg.ALLOW_ANONYMOUS) {
    throw new Error('Set WIDGET_TOKEN_SECRET (signed-in users) and/or ALLOW_ANONYMOUS=true (guests).');
  }
  if (cfg.PLAYGROUND_PASSWORD !== undefined && cfg.PLAYGROUND_PASSWORD.length > 0 && cfg.PLAYGROUND_PASSWORD.length < 12) {
    throw new Error('PLAYGROUND_PASSWORD must be at least 12 characters.');
  }
  if (cfg.SERVICE_API_KEY !== undefined && cfg.SERVICE_API_KEY.length > 0 && cfg.SERVICE_API_KEY.length < 16) {
    throw new Error('SERVICE_API_KEY must be at least 16 characters.');
  }
  // Chats and usage live in MongoDB; the in-memory fallback is lost on restart and never shared across instances.
  if (isProduction(cfg) && !cfg.MONGODB_URI) {
    throw new Error('Set MONGODB_URI: production must store chats and usage in MongoDB, not in memory.');
  }
  if (cfg.PORTFOLIO_SOURCE === 'roborupee' && !cfg.ROBORUPEE_API_URL) {
    throw new Error('Set ROBORUPEE_API_URL when PORTFOLIO_SOURCE=roborupee (the Robo Rupee admin API base URL).');
  }
  return cfg;
}
