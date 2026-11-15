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
 *
 * The host app (Robo Rupee) signs a JWT of a slightly different shape and we verify the same token,
 * so one login serves both chat identity and the host's read APIs (e.g. holdings):
 *   payload = { "user_id": { "user_id": <id>, "user_type": "advisor"|"customer" }, "iss": "…", "iat", "exp" }
 * The user id is read from `sub` when present, otherwise from `user_id` (an object's `.user_id`, or a scalar).
 */
export interface UserClaims {
  /** User id. Carried in the JWT `sub` claim, or the host app's `user_id`. */
  uid: string;
  name?: string;
  risk?: string;
  /** `advisor` / `customer` etc., when the token carries it. */
  userType?: string;
  /** Expiry, Unix seconds. */
  exp: number;
}

/** Reads the user id (and optional user type) from either token shape. */
function readSubject(claims: { sub?: unknown; user_id?: unknown; user_type?: unknown }): { uid?: string; userType?: string } {
  if (claims.sub !== undefined && claims.sub !== null) return { uid: String(claims.sub) };
  const u = claims.user_id;
  if (u !== undefined && u !== null) {
    if (typeof u === 'object') {
      const inner = u as { user_id?: unknown; user_type?: unknown };
      return {
        uid: inner.user_id === undefined || inner.user_id === null ? undefined : String(inner.user_id),
        userType: typeof inner.user_type === 'string' ? inner.user_type : undefined,
      };
    }
    return { uid: String(u), userType: typeof claims.user_type === 'string' ? claims.user_type : undefined };
  }
  return {};
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

/** Parses a JWT payload into our claims, enforcing expiry but WITHOUT checking the signature. */
function buildClaims(payloadSegment: string, nowSeconds: number): VerifyResult {
  let claims: { sub?: unknown; user_id?: unknown; user_type?: unknown; name?: unknown; risk?: unknown; exp?: unknown; nbf?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const { uid, userType } = readSubject(claims);
  if (uid === undefined || uid.length === 0 || uid.length > 64) return { ok: false, reason: 'malformed' };
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.exp < nowSeconds) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      uid,
      exp: claims.exp,
      ...(userType && { userType: userType.slice(0, 40) }),
      ...(typeof claims.name === 'string' && claims.name && { name: claims.name.slice(0, 60) }),
      ...(typeof claims.risk === 'string' && claims.risk && { risk: claims.risk.slice(0, 40) }),
    },
  };
}

/**
 * Reads a token's claims WITHOUT verifying its signature. Use ONLY for a token the operator supplied
 * through server config (PLAYGROUND_USER_TOKEN) — never for a browser-supplied bearer token.
 */
export function decodeUserToken(token: string, nowSeconds = Date.now() / 1000): VerifyResult {
  const [header, payload, signature, extra] = token.split('.');
  if (!header || !payload || !signature || extra !== undefined) return { ok: false, reason: 'malformed' };
  return buildClaims(payload, nowSeconds);
}

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

  return buildClaims(payload, nowSeconds);
}
