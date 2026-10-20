// Mirrors the server's GET /api/orders contract (server/src/orders/query.ts and
// repository.ts). Kept as a small copy rather than a shared package.

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type SortField = "createdAt" | "total";
export type SortDirection = "asc" | "desc";

export const PAGE_SIZES = [25, 50, 100] as const;
export const MAX_SEARCH_LENGTH = 100;

export interface OrdersQuery {
  page: number;
  pageSize: number;
  search: string; // "" = no search
  status: OrderStatus | ""; // "" = all statuses
  sortBy: SortField;
  sortDir: SortDirection;
}

export interface OrderSummary {
  id: number;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
}

export interface OrdersPage {
  data: OrderSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// The signature the UI depends on, so tests can pass a controllable fake.
export type FetchOrders = (query: OrdersQuery, signal: AbortSignal) => Promise<OrdersPage>;

export interface FieldError {
  field: string; // same path format as the server, e.g. "items[0].quantity"
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: FieldError[];

  constructor(message: string, status: number, details: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown; details?: unknown };
    if (typeof body.error === "string") {
      return new ApiError(body.error, res.status, Array.isArray(body.details) ? (body.details as FieldError[]) : []);
    }
  } catch {
    // Not JSON (e.g. the dev proxy could not reach the API): use the generic message.
  }
  return new ApiError(`Request failed (HTTP ${res.status})`, res.status);
}

export const fetchOrders: FetchOrders = async (query, signal) => {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sortBy: query.sortBy,
    sortDir: query.sortDir,
  });
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);

  const res = await fetch(`/api/orders?${params}`, { signal });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as OrdersPage;
};

// ---- Create order (R2) ----

export interface NewOrderItem {
  productName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface NewOrder {
  customerName: string;
  customerEmail: string;
  items: NewOrderItem[];
}

export interface CreatedOrder extends OrderSummary {
  items: (NewOrderItem & { lineNo: number })[];
}

export interface CreateOrderResult {
  order: CreatedOrder;
  replayed: boolean; // true: the server had already saved this exact request
}

export type CreateOrder = (order: NewOrder, idempotencyKey: string) => Promise<CreateOrderResult>;

// After this long the client stops waiting. The outcome is then unknown, which is
// exactly the case the Idempotency-Key exists for: retrying with the same key is safe.
export const CREATE_TIMEOUT_MS = 15_000;

export const createOrder: CreateOrder = async (order, idempotencyKey) => {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(order),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as { order: CreatedOrder };
  return { order: body.order, replayed: res.headers.get("Idempotent-Replayed") === "true" };
};
