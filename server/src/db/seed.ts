import { hashPassword } from "../auth/passwords";
import type { Db } from "./connection";
import { applySchema, dropSchema, type OrderStatus, type UserRole } from "./schema";

// Demo accounts for local use only. The plain passwords are documented in the README;
// only their scrypt hashes are written to the database.
export const DEMO_USERS: readonly { email: string; password: string; role: UserRole }[] = [
  { email: "admin@orders.test", password: "Admin123!", role: "admin" },
  { email: "agent@orders.test", password: "Agent123!", role: "agent" },
];

export const DEFAULT_ORDER_COUNT = 50_000;

const FIRST_NAMES = [
  "Ahmed", "Mohamed", "Omar", "Youssef", "Khaled", "Ali", "Hassan", "Ibrahim", "Mahmoud", "Tarek",
  "Fatima", "Aisha", "Mariam", "Nour", "Layla", "Sara", "Huda", "Reem", "Salma", "Yasmin",
  "John", "Michael", "David", "James", "Daniel", "Emma", "Olivia", "Sophia", "Grace", "Chloe",
  "Raj", "Priya", "Arjun", "Wei", "Mei", "Hiroshi", "Yuki", "Carlos", "Lucia", "Mateo",
];

const LAST_NAMES = [
  "Hassan", "Khalil", "Mansour", "Saleh", "Haddad", "Nasser", "Farouk", "Rashid", "Aziz", "Qasim",
  "Alharbi", "Alotaibi", "Alqahtani", "Alshehri", "Almutairi", "Ghamdi", "Zahrani", "Dosari", "Shammari", "Anazi",
  "Smith", "Johnson", "Brown", "Williams", "Taylor", "Wilson", "Davies", "Evans", "Clarke", "Walker",
  "Patel", "Sharma", "Chen", "Wang", "Tanaka", "Sato", "Garcia", "Lopez", "Martin", "Silva",
];

const EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com", "proton.me"];

const PRODUCTS: readonly { name: string; priceCents: number }[] = [
  { name: "Wireless Mouse", priceCents: 2_499 },
  { name: "Mechanical Keyboard", priceCents: 8_999 },
  { name: "USB-C Cable", priceCents: 999 },
  { name: "Laptop Stand", priceCents: 3_450 },
  { name: "27\" Monitor", priceCents: 24_900 },
  { name: "Noise-Cancelling Headphones", priceCents: 19_999 },
  { name: "Webcam HD", priceCents: 5_999 },
  { name: "Desk Lamp", priceCents: 2_850 },
  { name: "Office Chair", priceCents: 32_000 },
  { name: "External SSD 1TB", priceCents: 10_999 },
  { name: "Phone Case", priceCents: 1_499 },
  { name: "Screen Protector", priceCents: 799 },
  { name: "Power Bank", priceCents: 3_999 },
  { name: "Smart Watch", priceCents: 22_900 },
  { name: "Bluetooth Speaker", priceCents: 6_450 },
  { name: "Coffee Mug", priceCents: 1_200 },
  { name: "Notebook A5", priceCents: 650 },
  { name: "Backpack", priceCents: 4_999 },
  { name: "Water Bottle", priceCents: 1_850 },
  { name: "HDMI Adapter", priceCents: 1_999 },
];

// Weighted so the data looks like a real shop: most orders are delivered,
// fewer are cancelled, and small orders are more common than large ones.
const STATUS_WEIGHTS: readonly [OrderStatus, number][] = [
  ["delivered", 45], ["shipped", 15], ["paid", 15], ["pending", 15], ["cancelled", 10],
];
const ITEM_COUNT_WEIGHTS: readonly [number, number][] = [[1, 35], [2, 25], [3, 20], [4, 12], [5, 8]];
const QUANTITY_WEIGHTS: readonly [number, number][] = [[1, 70], [2, 20], [3, 10]];

const CUSTOMER_POOL_SIZE = 5_000; // repeat customers, so one search can match several orders
const HISTORY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// mulberry32: a tiny deterministic PRNG. The same seed always produces the same
// data, so test runs and benchmarks are reproducible. Not for anything security-related.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

function randomInt(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(random: Random, values: readonly T[]): T {
  return values[randomInt(random, 0, values.length - 1)]!;
}

function pickWeighted<T>(random: Random, weighted: readonly [T, number][]): T {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return weighted[weighted.length - 1]![0];
}

// Partial Fisher–Yates shuffle: `count` distinct values, each equally likely.
function pickDistinct<T>(random: Random, values: readonly T[], count: number): T[] {
  const pool = [...values];
  for (let i = 0; i < count; i++) {
    const j = randomInt(random, i, pool.length - 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

function buildCustomers(random: Random): { name: string; email: string }[] {
  return Array.from({ length: CUSTOMER_POOL_SIZE }, () => {
    const first = pick(random, FIRST_NAMES);
    const last = pick(random, LAST_NAMES);
    const email = `${first}.${last}${randomInt(random, 1, 999)}@${pick(random, EMAIL_DOMAINS)}`.toLowerCase();
    return { name: `${first} ${last}`, email };
  });
}

export interface SeedOptions {
  orderCount?: number;
  randomSeed?: number;
  now?: Date;
}

export interface SeedSummary {
  users: number;
  orders: number;
  orderItems: number;
}

// Rebuilds the database from scratch: drops all tables, recreates the schema and
// inserts the demo users and orders. Everything runs in ONE transaction, so a failed
// seed leaves the previous data untouched and re-running never duplicates rows.
export async function seedDatabase(db: Db, options: SeedOptions = {}): Promise<SeedSummary> {
  const { orderCount = DEFAULT_ORDER_COUNT, randomSeed = 2026, now = new Date() } = options;
  if (!Number.isInteger(orderCount) || orderCount < 1) {
    throw new Error(`orderCount must be a positive integer, got ${orderCount}`);
  }
  const random = createRandom(randomSeed);

  // Hashing is async (it runs on libuv's thread pool), so do it before the
  // synchronous transaction starts.
  const users = await Promise.all(
    DEMO_USERS.map(async (user) => ({ ...user, passwordHash: await hashPassword(user.password) })),
  );

  const customers = buildCustomers(random);
  // Sorted so ids grow with created_at, like a real append-only orders table.
  const createdAtTimes = Array.from({ length: orderCount }, () => now.getTime() - random() * HISTORY_DAYS * DAY_MS)
    .sort((a, b) => a - b);

  const seedAll = db.transaction(() => {
    dropSchema(db);
    applySchema(db);

    // Prepared after applySchema: on a fresh database the tables do not exist before it.
    const insertUser = db.prepare(
      "INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertOrder = db.prepare(
      "INSERT INTO orders (customer_name, customer_email, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertItem = db.prepare(
      "INSERT INTO order_items (order_id, line_no, product_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)",
    );

    for (const user of users) {
      insertUser.run(user.email, user.passwordHash, user.role, now.toISOString());
    }

    let orderItems = 0;
    for (const createdAt of createdAtTimes) {
      const customer = pick(random, customers);
      const itemCount = pickWeighted(random, ITEM_COUNT_WEIGHTS);
      const lines = pickDistinct(random, PRODUCTS, itemCount).map((product) => ({
        product,
        quantity: pickWeighted(random, QUANTITY_WEIGHTS),
      }));
      const totalCents = lines.reduce((sum, line) => sum + line.quantity * line.product.priceCents, 0);

      const { lastInsertRowid: orderId } = insertOrder.run(
        customer.name,
        customer.email,
        pickWeighted(random, STATUS_WEIGHTS),
        totalCents,
        new Date(createdAt).toISOString(),
      );
      lines.forEach((line, index) => {
        insertItem.run(orderId, index + 1, line.product.name, line.quantity, line.product.priceCents);
      });
      orderItems += lines.length;
    }

    return { users: users.length, orders: createdAtTimes.length, orderItems };
  });

  return seedAll();
}
