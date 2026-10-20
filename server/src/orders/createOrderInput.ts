import { createHash } from "node:crypto";
import { MAX_ITEMS_PER_ORDER } from "../db/schema";

export const MAX_TEXT_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_QUANTITY = 1_000;
export const MAX_UNIT_PRICE_CENTS = 10_000_000; // 100,000.00 per unit
// Worst case total: 5 lines * 1,000 * 10,000,000 = 5e10 cents, far below
// Number.MAX_SAFE_INTEGER (~9e15) and SQLite's 64-bit INTEGER, so the sum cannot overflow.

// Pragmatic shape check (something@something.tld), not full RFC 5322.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Long enough to be unguessable in practice; the client sends a UUID v4.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

export interface CreateOrderItemInput {
  productName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CreateOrderInput {
  customerName: string;
  customerEmail: string;
  items: CreateOrderItemInput[];
}

export interface FieldError {
  field: string;
  message: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const ORDER_FIELDS = ["customerName", "customerEmail", "items"];
const ITEM_FIELDS = ["productName", "quantity", "unitPriceCents"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(object: Record<string, unknown>, allowed: string[], prefix: string, errors: FieldError[]) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) errors.push({ field: `${prefix}${key}`, message: "Unknown field" });
  }
}

function readText(value: unknown, field: string, maxLength: number, errors: FieldError[]): string {
  if (typeof value !== "string") {
    errors.push({ field, message: "Must be a string" });
    return "";
  }
  const text = value.trim();
  if (text === "") errors.push({ field, message: "Is required" });
  else if (text.length > maxLength) errors.push({ field, message: `Must be at most ${maxLength} characters` });
  return text;
}

// Only real JSON numbers that are safe integers: rejects "10" (a string), 12.5,
// NaN-like values and anything beyond 2^53. SQLite would silently coerce "10.00",
// so the type check has to happen here.
function readInteger(value: unknown, field: string, min: number, max: number, errors: FieldError[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    errors.push({ field, message: "Must be a whole number" });
    return 0;
  }
  if (value < min || value > max) errors.push({ field, message: `Must be between ${min} and ${max}` });
  return value;
}

export function parseCreateOrderInput(body: unknown): Result<CreateOrderInput> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "body", message: "Must be a JSON object" }] };
  }
  const errors: FieldError[] = [];
  rejectUnknownFields(body, ORDER_FIELDS, "", errors); // e.g. a client-sent "totalCents" is refused

  const customerName = readText(body.customerName, "customerName", MAX_TEXT_LENGTH, errors);
  const customerEmail = readText(body.customerEmail, "customerEmail", MAX_EMAIL_LENGTH, errors);
  if (customerEmail !== "" && !EMAIL_PATTERN.test(customerEmail)) {
    errors.push({ field: "customerEmail", message: "Must be a valid email address" });
  }

  const items: CreateOrderItemInput[] = [];
  if (!Array.isArray(body.items)) {
    errors.push({ field: "items", message: "Must be an array" });
  } else if (body.items.length < 1 || body.items.length > MAX_ITEMS_PER_ORDER) {
    errors.push({ field: "items", message: `Must contain 1 to ${MAX_ITEMS_PER_ORDER} items` });
  } else {
    body.items.forEach((item: unknown, index: number) => {
      const prefix = `items[${index}].`;
      if (!isPlainObject(item)) {
        errors.push({ field: `items[${index}]`, message: "Must be an object" });
        return;
      }
      rejectUnknownFields(item, ITEM_FIELDS, prefix, errors);
      items.push({
        productName: readText(item.productName, `${prefix}productName`, MAX_TEXT_LENGTH, errors),
        quantity: readInteger(item.quantity, `${prefix}quantity`, 1, MAX_QUANTITY, errors),
        unitPriceCents: readInteger(item.unitPriceCents, `${prefix}unitPriceCents`, 1, MAX_UNIT_PRICE_CENTS, errors),
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { customerName, customerEmail, items } };
}

export function parseIdempotencyKey(header: string | undefined): Result<string> {
  if (header === undefined || header === "") {
    return { ok: false, errors: [{ field: "Idempotency-Key", message: "Header is required" }] };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    return {
      ok: false,
      errors: [{ field: "Idempotency-Key", message: "Must be 16-100 characters of A-Z, a-z, 0-9, '-' or '_'" }],
    };
  }
  return { ok: true, value: header };
}

// The server is the only place a total is computed. Integer cents only.
export function totalCentsOf(items: CreateOrderItemInput[]): number {
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Order total exceeds the safe integer range");
  return total;
}

// SHA-256 of the validated, trimmed payload, serialised in a fixed field order.
// Two requests that would create the same order get the same fingerprint, even if
// their JSON differs in key order or surrounding whitespace.
export function fingerprintOf(input: CreateOrderInput): string {
  const canonical = JSON.stringify([
    input.customerName,
    input.customerEmail,
    input.items.map((item) => [item.productName, item.quantity, item.unitPriceCents]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
