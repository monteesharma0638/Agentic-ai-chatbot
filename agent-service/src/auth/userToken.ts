import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Standard JSON Web Token (JWT), HS256, minted by the host website on a
 * different server and handed to the widget (e.g. `data-token="…"`). Our server
 * holds the same secret, verifies the signature and reads the user id from the
 * `sub` claim — no database lookup, no call back to that server.
 *
 *   token = base64url(header) + "." + base64url(payload) + "." + base64url(HMAC-SHA256(header.payload, secret))
 *   header  = { "alg": "HS256", "typ": "JWT" }
 *   payload = { "sub": "<userId>", "name"?: "…", "risk"?: "…", "iat": <unix s>, "exp": <unix s> }
 */
export interface UserClaims {
  /** User id. Carried in the JWT `sub` claim. */
  uid: string;
  name?: string;
  risk?: string;
  /** Expiry, Unix seconds. */
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/** Mints a JWT, for the dev/token route, scripts/token.mjs and tests (the real token comes from the website). */
export function signUserToken(claims: UserClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: String(claims.uid),
      ...(claims.name && { name: claims.name }),
      ...(claims.risk && { risk: claims.risk }),
      iat: Math.floor(Date.now() / 1000),
      exp: claims.exp,
    }),
  ).toString('base64url');
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export type VerifyResult = { ok: true; claims: UserClaims } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyUserToken(token: string, secret: string, nowSeconds = Date.now() / 1000): VerifyResult {
  const [header, payload, signature, extra] = token.split('.');
  if (!header || !payload || !signature || extra !== undefined) return { ok: false, reason: 'malformed' };

  // Pin the algorithm to HS256 before verifying: never trust the token's own `alg` (defeats "alg: none" and
  // RS256→HS256 confusion attacks).
  let alg: unknown;
  try {
    alg = (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown }).alg;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (alg !== 'HS256') return { ok: false, reason: 'bad_signature' };

  const expected = Buffer.from(sign(`${header}.${payload}`, secret), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: 'bad_signature' };

  let claims: { sub?: unknown; name?: unknown; risk?: unknown; exp?: unknown; nbf?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const sub = claims.sub;
  if (sub === undefined || sub === null || String(sub).length === 0 || String(sub).length > 64) return { ok: false, reason: 'malformed' };
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.exp < nowSeconds) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      uid: String(sub),
      exp: claims.exp,
      ...(typeof claims.name === 'string' && claims.name && { name: claims.name.slice(0, 60) }),
      ...(typeof claims.risk === 'string' && claims.risk && { risk: claims.risk.slice(0, 40) }),
    },
  };
}
