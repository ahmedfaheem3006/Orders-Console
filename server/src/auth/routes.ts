import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "../db/connection";
import type { UserRole } from "../db/schema";
import type { LoginRateLimiter } from "./loginRateLimiter";
import { hashPassword, verifyPassword } from "./passwords";
import { signAccessToken } from "./tokens";

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200; // bounds the work an attacker can make scrypt do
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldError {
  field: string;
  message: string;
}

type LoginInput = { ok: true; email: string; password: string } | { ok: false; errors: FieldError[] };

function parseLoginInput(body: unknown): LoginInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "Must be a JSON object" }] };
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (key !== "email" && key !== "password") errors.push({ field: key, message: "Unknown field" });
  }

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (typeof input.email !== "string" || email === "") errors.push({ field: "email", message: "Is required" });
  else if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    errors.push({ field: "email", message: "Must be a valid email address" });
  }

  // The password is used exactly as sent (no trimming).
  const password = typeof input.password === "string" ? input.password : "";
  if (password === "") errors.push({ field: "password", message: "Is required" });
  else if (password.length > MAX_PASSWORD_LENGTH) {
    errors.push({ field: "password", message: `Must be at most ${MAX_PASSWORD_LENGTH} characters` });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, email, password };
}

// Unknown emails are checked against this hash, so they cost the same scrypt work as
// real ones and response time does not reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID()));

interface AuthRouterOptions {
  jwtSecret: string;
  rateLimiter: LoginRateLimiter;
}

export function createAuthRouter(db: Db, { jwtSecret, rateLimiter }: AuthRouterOptions): Router {
  const router = Router();
  const findUser = db.prepare("SELECT id, email, role, password_hash AS passwordHash FROM users WHERE email = ?");

  // Never logs the body: it contains the password.
  router.post("/login", async (req, res) => {
    const input = parseLoginInput(req.body);
    if (!input.ok) {
      res.status(400).json({ error: "Invalid login request", details: input.errors });
      return;
    }

    const ip = req.ip ?? "unknown";
    const retryAfter = rateLimiter.retryAfterSeconds(ip, input.email);
    if (retryAfter > 0) {
      res.status(429).set("Retry-After", String(retryAfter)).json({ error: "Too many login attempts. Try again later." });
      return;
    }
    rateLimiter.recordAttempt(ip, input.email);

    // users.email is COLLATE NOCASE, so the lookup is case-insensitive.
    const user = findUser.get(input.email) as
      | { id: number; email: string; role: UserRole; passwordHash: string }
      | undefined;
    const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !passwordOk) {
      // Same message for "no such user" and "wrong password".
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    rateLimiter.recordSuccess(ip, input.email);
    const { token, expiresAt } = signAccessToken(user.id, jwtSecret);
    res.json({ token, expiresAt, user: { id: user.id, email: user.email, role: user.role } });
  });

  return router;
}
