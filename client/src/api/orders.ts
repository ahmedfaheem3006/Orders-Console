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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON (e.g. the dev proxy could not reach the API): use the generic message.
  }
  return `Request failed (HTTP ${res.status})`;
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
  if (!res.ok) throw new ApiError(await readErrorMessage(res), res.status);
  return (await res.json()) as OrdersPage;
};
