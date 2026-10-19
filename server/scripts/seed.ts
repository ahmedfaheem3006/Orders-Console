import { config } from "../src/config";
import { openDatabase } from "../src/db/connection";
import { seedDatabase } from "../src/db/seed";

const db = openDatabase(config.databasePath);
const startedAt = performance.now();
const summary = await seedDatabase(db);
const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);

// Fold the large write-ahead log back into the main file and truncate it.
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log(`Seeded ${config.databasePath}`);
console.log(`  users:       ${summary.users}`);
console.log(`  orders:      ${summary.orders}`);
console.log(`  order_items: ${summary.orderItems}`);
console.log(`  took ${seconds}s`);
