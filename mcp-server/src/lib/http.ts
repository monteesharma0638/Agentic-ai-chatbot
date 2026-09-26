import { config } from '../config.js';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** GET with timeout and a small exponential backoff on transient failures. */
export async function httpGet(url: string, { retries = 2 }: { retries?: number } = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.userAgent, Accept: '*/*' },
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
      if (res.ok) return res;
      if (!RETRYABLE.has(res.status)) {
        throw new UpstreamError(`Upstream ${new URL(url).host} responded ${res.status}`, res.status);
      }
      lastError = new UpstreamError(`Upstream ${new URL(url).host} responded ${res.status}`, res.status);
    } catch (err) {
      if (err instanceof UpstreamError && err.status && !RETRYABLE.has(err.status)) throw err;
      lastError = err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new UpstreamError(`Could not reach data provider: ${reason}`);
}
