import fs from "node:fs";
import { createApp } from "./app";
import { config, loadJwtSecret } from "./config";
import { openDatabase } from "./db/connection";
import { assertSchemaReady } from "./db/schema";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let jwtSecret: string;
try {
  jwtSecret = loadJwtSecret();
} catch (error) {
  fail((error as Error).message);
}

// The server never creates, wipes or seeds data on its own: that is `npm run seed`.
if (!fs.existsSync(config.databasePath)) {
  fail(`Database not found at ${config.databasePath}. Run "npm run seed" first.`);
}

const db = openDatabase(config.databasePath);
try {
  assertSchemaReady(db);
} catch (error) {
  db.close();
  fail((error as Error).message);
}

// Loopback only. This is a local development server over plain HTTP (no TLS), so
// bearer tokens and customer data must not travel over a real network.
const HOST = "127.0.0.1";

createApp({ db, jwtSecret, simulatedLatencyMs: config.simulatedLatencyMs }).listen(config.port, HOST, () => {
  console.log(`API listening on http://${HOST}:${config.port}`);
  if (config.simulatedLatencyMs > 0) {
    console.log(`Simulated latency: random 0-${config.simulatedLatencyMs} ms on /api/orders`);
  }
});
