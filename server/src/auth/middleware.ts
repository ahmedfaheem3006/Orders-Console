import type { Request, RequestHandler, Response } from "express";
import type { Db } from "../db/connection";
import type { UserRole } from "../db/schema";
import { verifyAccessToken } from "./tokens";

export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
}

// Adds a typed `user` to every Express request. It is only set by requireAuth.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Exactly "Bearer <header>.<payload>.<signature>" (the scheme name is case-insensitive
// per RFC 7235). Nothing else is accepted: no query-string tokens, no cookies, no
// extra spaces or parts.
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

function unauthorized(res: Response, error: string): void {
  res.status(401).set("WWW-Authenticate", "Bearer").json({ error });
}

export function requireAuth(db: Db, jwtSecret: string): RequestHandler {
  const findUser = db.prepare("SELECT id, email, role FROM users WHERE id = ?");

  return (req, res, next) => {
    const match = BEARER_PATTERN.exec(req.get("Authorization") ?? "");
    if (!match) {
      unauthorized(res, "Authentication required");
      return;
    }
    const userId = verifyAccessToken(match[1]!, jwtSecret);
    // A valid signature is not enough: the user must still exist. The role comes from
    // this row, never from the token or the request.
    const user = userId === null ? undefined : (findUser.get(userId) as AuthUser | undefined);
    if (!user) {
      unauthorized(res, "Invalid or expired token");
      return;
    }
    req.user = user;
    next();
  };
}

// For handlers mounted behind requireAuth. Throws (-> 500) if that was forgotten,
// rather than silently treating the request as anonymous.
export function getAuthUser(req: Request): AuthUser {
  if (!req.user) throw new Error("getAuthUser called on a route without requireAuth");
  return req.user;
}

export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!allowed.includes(getAuthUser(req).role)) {
      res.status(403).json({ error: "You do not have permission to do this" });
      return;
    }
    next();
  };
}
