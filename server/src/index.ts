import fs from "node:fs";
import { createApp } from "./app";
import { config } from "./config";
import { openDatabase } from "./db/connection";
import { assertSchemaReady } from "./db/schema";

// The server never creates, wipes or seeds data on its own: that is `npm run seed`.
if (!fs.existsSync(config.databasePath)) {
  console.error(`Database not found at ${config.databasePath}. Run "npm run seed" first.`);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
try {
  assertSchemaReady(db);
} catch (error) {
  console.error((error as Error).message);
  db.close();
  process.exit(1);
}

createApp({ db, simulatedLatencyMs: config.simulatedLatencyMs }).listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  if (config.simulatedLatencyMs > 0) {
    console.log(`Simulated latency: random 0-${config.simulatedLatencyMs} ms on /api/orders`);
  }
});
