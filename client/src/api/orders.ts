import { toApiError } from "./http";

// Mirrors the server's /api/orders contract (server/src/orders/query.ts and
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

export type DeleteOrder = (orderId: number) => Promise<void>;

// After this long the client stops waiting for a create. The outcome is then unknown,
// which is exactly the case the Idempotency-Key exists for: retrying with the same key is safe.
export const CREATE_TIMEOUT_MS = 15_000;

export interface ApiClient {
  fetchOrders: FetchOrders;
  createOrder: CreateOrder;
  deleteOrder: DeleteOrder;
}

// All /api/orders calls go through here, so every request carries the token and any
// 401 (token expired, user removed) ends the session in one place.
export function createApiClient(token: string, onUnauthorized: () => void): ApiClient {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  return {
    fetchOrders: async (query, signal) => {
      const params = new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
        sortBy: query.sortBy,
        sortDir: query.sortDir,
      });
      if (query.search) params.set("search", query.search);
      if (query.status) params.set("status", query.status);
      const res = await request(`/api/orders?${params}`, { signal });
      return (await res.json()) as OrdersPage;
    },

    createOrder: async (order, idempotencyKey) => {
      const res = await request("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(order),
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      });
      const body = (await res.json()) as { order: CreatedOrder };
      return { order: body.order, replayed: res.headers.get("Idempotent-Replayed") === "true" };
    },

    deleteOrder: async (orderId) => {
      await request(`/api/orders/${orderId}`, { method: "DELETE" });
    },
  };
}
