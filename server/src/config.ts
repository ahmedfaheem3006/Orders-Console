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

export const config = {
  port: readPort(),
  databasePath: readDatabasePath(),
  simulatedLatencyMs: readSimulatedLatency(),
};
