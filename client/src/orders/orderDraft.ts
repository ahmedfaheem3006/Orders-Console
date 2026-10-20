import type { NewOrder } from "../api/orders";

// Limits mirror server/src/orders/createOrderInput.ts. The server re-validates
// everything; these checks only give faster, field-level feedback.
export const MAX_ITEMS = 5;
export const MAX_TEXT_LENGTH = 200;
export const MAX_QUANTITY = 1_000;
export const MAX_UNIT_PRICE_CENTS = 10_000_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What the inputs hold: raw text, so half-typed values like "12." are allowed while editing.
export interface ItemDraft {
  key: number; // stable React key for add/remove
  productName: string;
  quantity: string;
  unitPrice: string; // e.g. "24.99", in SAR
}

export interface OrderDraft {
  customerName: string;
  customerEmail: string;
  items: ItemDraft[];
}

// Keyed by the same paths the server uses ("customerEmail", "items[1].quantity"),
// so server validation errors can be shown next to the right input.
export type DraftErrors = Record<string, string>;

let nextItemKey = 1;
export function emptyItem(): ItemDraft {
  return { key: nextItemKey++, productName: "", quantity: "1", unitPrice: "" };
}

export function emptyDraft(): OrderDraft {
  return { customerName: "", customerEmail: "", items: [emptyItem()] };
}

// "24.99" -> 2499. Parsed from the text, never via 24.99 * 100 (which is
// 2498.9999999999995 in floating point). At most 2 decimals; null if invalid.
export function parsePriceToCents(text: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents >= 1 && cents <= MAX_UNIT_PRICE_CENTS ? cents : null;
}

export function parseQuantity(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const quantity = Number(text.trim());
  return quantity >= 1 && quantity <= MAX_QUANTITY ? quantity : null;
}

// Sum of the lines that are currently valid, in cents (for the live total).
export function draftTotalCents(draft: OrderDraft): number {
  return draft.items.reduce((sum, item) => {
    const quantity = parseQuantity(item.quantity);
    const price = parsePriceToCents(item.unitPrice);
    return quantity !== null && price !== null ? sum + quantity * price : sum;
  }, 0);
}

export function validateDraft(draft: OrderDraft): { payload: NewOrder | null; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const customerName = draft.customerName.trim();
  const customerEmail = draft.customerEmail.trim();

  if (customerName === "") errors.customerName = "Enter the customer's name";
  else if (customerName.length > MAX_TEXT_LENGTH) errors.customerName = `At most ${MAX_TEXT_LENGTH} characters`;

  if (customerEmail === "") errors.customerEmail = "Enter the customer's email";
  else if (!EMAIL_PATTERN.test(customerEmail)) errors.customerEmail = "Enter a valid email, e.g. name@example.com";

  if (draft.items.length < 1 || draft.items.length > MAX_ITEMS) errors.items = `Add 1 to ${MAX_ITEMS} items`;

  const items = draft.items.map((item, index) => {
    const productName = item.productName.trim();
    const quantity = parseQuantity(item.quantity);
    const unitPriceCents = parsePriceToCents(item.unitPrice);
    if (productName === "") errors[`items[${index}].productName`] = "Enter a product";
    else if (productName.length > MAX_TEXT_LENGTH) errors[`items[${index}].productName`] = `At most ${MAX_TEXT_LENGTH} characters`;
    if (quantity === null) errors[`items[${index}].quantity`] = `Whole number, 1–${MAX_QUANTITY}`;
    if (unitPriceCents === null) errors[`items[${index}].unitPriceCents`] = "Price like 24.99 (max 100,000.00)";
    return { productName, quantity: quantity ?? 0, unitPriceCents: unitPriceCents ?? 0 };
  });

  if (Object.keys(errors).length > 0) return { payload: null, errors };
  return { payload: { customerName, customerEmail, items }, errors };
}
