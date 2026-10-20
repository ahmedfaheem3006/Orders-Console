import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import { createApiClient, type OrdersQuery } from "./orders";

const QUERY: OrdersQuery = { page: 1, pageSize: 25, search: "", status: "", sortBy: "createdAt", sortDir: "desc" };

interface SentRequest {
  url: string;
  method: string;
  headers: Headers;
}

// Records every request; answers with `respond(method)`.
function stubFetch(respond: (method: string) => Response) {
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      sent.push({ url, method, headers: new Headers(init.headers) });
      return respond(method);
    }),
  );
  return sent;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe("createApiClient", () => {
  it("sends the token as a Bearer header on every call, and never in the URL", async () => {
    const sent = stubFetch((method) =>
      method === "GET"
        ? json(200, { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } })
        : method === "POST"
          ? json(201, { order: { id: 1 } }, { "Idempotent-Replayed": "true" })
          : new Response(null, { status: 204 }),
    );
    const api = createApiClient("the.jwt.token", () => {});

    await api.fetchOrders(QUERY, new AbortController().signal);
    const created = await api.createOrder({ customerName: "A", customerEmail: "a@b.co", items: [] }, "key-123");
    await api.deleteOrder(7);

    expect(sent.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual(["GET /api/orders", "POST /api/orders", "DELETE /api/orders/7"]);
    for (const request of sent) {
      expect(request.headers.get("Authorization")).toBe("Bearer the.jwt.token");
      expect(request.url).not.toContain("the.jwt.token");
    }
    expect(sent[1]!.headers.get("Idempotency-Key")).toBe("key-123");
    expect(created.replayed).toBe(true);
  });

  it("ends the session on 401 and still rejects the call", async () => {
    stubFetch(() => json(401, { error: "Invalid or expired token" }));
    const onUnauthorized = vi.fn();
    const api = createApiClient("expired", onUnauthorized);
    await expect(api.fetchOrders(QUERY, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not end the session on 403: the user is signed in, just not allowed", async () => {
    stubFetch(() => json(403, { error: "You do not have permission to do this" }));
    const onUnauthorized = vi.fn();
    const error = await createApiClient("agent-token", onUnauthorized).deleteOrder(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
