import jwt from "jsonwebtoken";

// HS256 only. Passing `algorithms` to verify() is what rejects "alg: none" tokens and
// tokens signed with any other algorithm, instead of trusting the token's own header.
const ALGORITHM = "HS256";
const ISSUER = "orders-console";
const AUDIENCE = "orders-console-api";
// One hour: no refresh tokens, so this is also how long a stolen token stays useful.
export const TOKEN_TTL_SECONDS = 60 * 60;

export interface AccessToken {
  token: string;
  expiresAt: string; // ISO date, so the client can end the session on time
}

// The token carries only who the user is (sub = user id). Their role is NOT put in
// the token: it is read from the database on every request, so a role change or a
// deleted user takes effect immediately and a token can never grant a role.
export function signAccessToken(userId: number, secret: string, now = new Date()): AccessToken {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const token = jwt.sign({ sub: String(userId), iat: issuedAt }, secret, {
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: TOKEN_TTL_SECONDS,
  });
  return { token, expiresAt: new Date((issuedAt + TOKEN_TTL_SECONDS) * 1000).toISOString() };
}

// Returns the user id from a valid token, or null for ANY problem: bad signature,
// wrong algorithm, expired, wrong issuer/audience, or a payload of the wrong shape.
// The reason is not returned on purpose: the client gets the same 401 either way.
export function verifyAccessToken(token: string, secret: string): number | null {
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  } catch {
    return null;
  }
  // jsonwebtoken enforces exp when present; we also require it to be present.
  if (typeof payload !== "object" || typeof payload.exp !== "number") return null;
  if (typeof payload.sub !== "string" || !/^[1-9]\d{0,15}$/.test(payload.sub)) return null;
  const userId = Number(payload.sub);
  return Number.isSafeInteger(userId) ? userId : null;
}
