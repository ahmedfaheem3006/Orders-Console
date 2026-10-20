import fs from "node:fs";
import path from "node:path";

// .env lives at the repository root, two levels above this file.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const envPath = path.join(repoRoot, ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function readPort(): number {
  const raw = process.env.PORT ?? "3001";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

// Relative paths are resolved from the repository root, so the same value
// works no matter which directory a script is started from.
function readDatabasePath(): string {
  const raw = process.env.DATABASE_PATH || "server/data/orders.db";
  return path.resolve(repoRoot, raw);
}

function readSimulatedLatency(): number {
  const raw = process.env.SIMULATED_LATENCY_MS || "0";
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0 || ms > 10_000) {
    throw new Error(`Invalid SIMULATED_LATENCY_MS: ${raw} (expected 0-10000)`);
  }
  return ms;
}

export const MIN_JWT_SECRET_LENGTH = 32;
// Secrets that are public and must never be accepted: the one hard-coded in the
// supplied auth.ts, and the example value from older docs.
const KNOWN_PUBLIC_SECRETS = new Set(["sarh-secret-2026", "replace-with-a-long-random-string"]);

// Read only by the API server at startup (the seed and benchmark scripts do not need it).
// Fails fast instead of silently running with a weak or missing secret. A length check
// cannot prove randomness: `npm run setup` generates 32 random bytes.
export function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  if (secret === "") {
    throw new Error('JWT_SECRET is not set. Run "npm run setup" to create .env with a random secret.');
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH || KNOWN_PUBLIC_SECRETS.has(secret)) {
    throw new Error(
      `JWT_SECRET is insecure: use at least ${MIN_JWT_SECRET_LENGTH} random characters (e.g. run "npm run setup").`,
    );
  }
  return secret;
}

export const config = {
  port: readPort(),
  databasePath: readDatabasePath(),
  simulatedLatencyMs: readSimulatedLatency(),
};
