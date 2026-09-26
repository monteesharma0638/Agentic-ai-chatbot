try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

function list(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((v) => v.trim()).filter(Boolean) ?? [];
  return items.length ? items : undefined;
}

export const config = {
  mfapiBaseUrl: process.env.MFAPI_BASE_URL ?? 'https://api.mfapi.in',
  amfiNavUrl: process.env.AMFI_NAV_URL ?? 'https://www.amfiindia.com/spages/NAVAll.txt',
  httpTimeoutMs: num(process.env.HTTP_TIMEOUT_MS, 20_000),
  /** AMFI publishes NAVs once a day (late evening IST), so a few hours of caching is safe. */
  directoryTtlMs: num(process.env.AMFI_CACHE_TTL_MIN, 180) * 60_000,
  historyTtlMs: num(process.env.HISTORY_CACHE_TTL_MIN, 60) * 60_000,
  historyCacheSize: num(process.env.HISTORY_CACHE_SIZE, 400),
  /** Annual risk-free rate (%) used for Sharpe / Sortino / alpha. ~91-day T-bill yield. */
  riskFreeRatePct: num(process.env.RISK_FREE_RATE_PCT, 6.5),
  /** Default benchmark proxy: UTI Nifty 50 Index Fund - Direct Growth. */
  benchmarkSchemeCode: num(process.env.BENCHMARK_SCHEME_CODE, 120716),
  /** Upper bound on schemes fetched by rank_funds_in_category (each one is an HTTP call). */
  rankMaxSchemes: num(process.env.RANK_MAX_SCHEMES, 80),
  host: process.env.MCP_HOST ?? '127.0.0.1',
  port: num(process.env.MCP_PORT ?? process.env.PORT, 3100),
  /** Undefined (not []) when unset, so the SDK falls back to its localhost defaults instead of rejecting every host. */
  allowedHosts: list(process.env.MCP_ALLOWED_HOSTS),
  authToken: process.env.MCP_AUTH_TOKEN || undefined,
  userAgent: process.env.HTTP_USER_AGENT ?? 'mf-chat-mcp/1.0',
};
