import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed user token, minted by the host website (e.g. one line of Blade)
 * so the widget can prove who is logged in without any backend code:
 *
 *   token = base64url(JSON {uid, name?, risk?, exp}) + "." + hex(HMAC-SHA256(payloadPart, secret))
 *
 * PHP equivalent:
 *   $p = rtrim(strtr(base64_encode(json_encode([...])), '+/', '-_'), '=');
 *   $token = $p.'.'.hash_hmac('sha256', $p, $secret);
 */
export interface UserClaims {
  uid: string;
  name?: string;
  risk?: string;
  /** Expiry, Unix seconds. */
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function signUserToken(claims: UserClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export type VerifyResult = { ok: true; claims: UserClaims } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyUserToken(token: string, secret: string, nowSeconds = Date.now() / 1000): VerifyResult {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = Buffer.from(sign(payload, secret), 'hex');
  const actual = Buffer.from(signature.toLowerCase(), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: 'bad_signature' };

  let claims: UserClaims;
  try {
    // PHP's base64 (after strtr) and Node's base64url decode the same way.
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UserClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.uid === undefined || claims.uid === null || String(claims.uid).length === 0 || String(claims.uid).length > 64) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    claims: {
      uid: String(claims.uid),
      exp: claims.exp,
      ...(typeof claims.name === 'string' && claims.name && { name: claims.name.slice(0, 60) }),
      ...(typeof claims.risk === 'string' && claims.risk && { risk: claims.risk.slice(0, 40) }),
    },
  };
}
