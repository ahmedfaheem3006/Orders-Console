import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { LoginRateLimiter } from "./auth/loginRateLimiter";
import { requireAuth } from "./auth/middleware";
import { createAuthRouter } from "./auth/routes";
import type { Db } from "./db/connection";
import { createOrdersRouter } from "./orders/routes";

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  // Development aid: delays each /api/orders response by a random 0..N ms so
  // out-of-order responses can be reproduced by hand. 0 (the default) disables it.
  simulatedLatencyMs?: number;
  loginRateLimiter?: LoginRateLimiter;
}

function randomDelay(maxMs: number): RequestHandler {
  return (_req, _res, next) => {
    setTimeout(next, Math.floor(Math.random() * (maxMs + 1)));
  };
}

// Never send stack traces or SQL errors to the client. Log only the error itself, not
// the request: query strings hold customer data, and login bodies hold passwords.
const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
  // Body-parser errors (e.g. malformed JSON) are client errors and carry a 4xx status.
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Internal server error" : "Bad request" });
};

// Builds the Express app without listening, so tests can start it on any port.
export function createApp({ db, jwtSecret, simulatedLatencyMs = 0, loginRateLimiter = new LoginRateLimiter() }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api", createAuthRouter(db, { jwtSecret, rateLimiter: loginRateLimiter }));

  if (simulatedLatencyMs > 0) app.use("/api/orders", randomDelay(simulatedLatencyMs));
  // Every /api/orders route requires a verified token; role checks are per route.
  app.use("/api/orders", requireAuth(db, jwtSecret), createOrdersRouter(db));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(handleError);

  return app;
}
