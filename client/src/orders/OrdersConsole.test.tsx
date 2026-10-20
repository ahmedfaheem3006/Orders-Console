import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateOrder, FetchOrders, OrdersPage, OrdersQuery } from "../api/orders";
import { OrdersConsole } from "./OrdersConsole";

// A fake fetch whose responses the test settles by hand, in any order.
// It deliberately IGNORES the abort signal: that is the case where abort alone
// would not protect the UI, so only the latest-request check can.
interface PendingCall {
  query: OrdersQuery;
  signal: AbortSignal;
  resolve: (page: OrdersPage) => void;
  reject: (error: unknown) => void;
}

function createControlledFetch() {
  const calls: PendingCall[] = [];
  const fetchPage: FetchOrders = (query, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ query, signal, resolve, reject });
    });
  return { fetchPage, calls };
}

function pageWith(customerName: string, totalPages = 1): OrdersPage {
  return {
    data: [
      {
        id: 1,
        customerName,
        customerEmail: "test@example.com",
        status: "paid",
        totalCents: 1000,
        createdAt: "2026-10-01T10:00:00.000Z",
      },
    ],
    pagination: { page: 1, pageSize: 25, total: totalPages * 25, totalPages },
  };
}

// Settles a promise inside act() so React applies the resulting state updates.
async function settle(action: () => void) {
  await act(async () => {
    action();
  });
}

const statusSelect = () => screen.getByLabelText("Status");
const table = () => screen.getByRole("table");

afterEach(cleanup);

describe("OrdersConsole: latest request wins", () => {
  it("shows only the latest result when the status filter changes 3 times and responses arrive out of order", async () => {
    const { fetchPage, calls } = createControlledFetch();
    render(<OrdersConsole fetchPage={fetchPage} />);
    await settle(() => calls[0]!.resolve(pageWith("Initial")));
    expect(screen.getByText("Initial")).toBeTruthy();

    // Three quick changes, before any response comes back.
    fireEvent.change(statusSelect(), { target: { value: "paid" } });
    fireEvent.change(statusSelect(), { target: { value: "pending" } });
    fireEvent.change(statusSelect(), { target: { value: "shipped" } });

    expect(calls.map((call) => call.query.status)).toEqual(["", "paid", "pending", "shipped"]);
    // The obsolete requests were cancelled; the latest one was not.
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(calls[2]!.signal.aborted).toBe(true);
    expect(calls[3]!.signal.aborted).toBe(false);

    // The latest response arrives first, then the older (slower) ones.
    await settle(() => calls[3]!.resolve(pageWith("Shipped result")));
    await settle(() => calls[2]!.resolve(pageWith("Pending result")));
    await settle(() => calls[1]!.resolve(pageWith("Paid result")));

    expect(screen.getByText("Shipped result")).toBeTruthy();
    expect(screen.queryByText("Pending result")).toBeNull();
    expect(screen.queryByText("Paid result")).toBeNull();
    expect(table().getAttribute("aria-busy")).toBe("false");
  });

  it("does not let an older response end the loading state of the newer request", async () => {
    const { fetchPage, calls } = createControlledFetch();
    render(<OrdersConsole fetchPage={fetchPage} />);
    await settle(() => calls[0]!.resolve(pageWith("Initial")));

    fireEvent.change(statusSelect(), { target: { value: "paid" } });
    fireEvent.change(statusSelect(), { target: { value: "pending" } });

    // The older request finishes while the newer one is still in flight.
    await settle(() => calls[1]!.resolve(pageWith("Paid result")));
    expect(screen.queryByText("Paid result")).toBeNull();
    expect(table().getAttribute("aria-busy")).toBe("true");

    await settle(() => calls[2]!.resolve(pageWith("Pending result")));
    expect(screen.getByText("Pending result")).toBeTruthy();
    expect(table().getAttribute("aria-busy")).toBe("false");
  });

  it("ignores an error from an obsolete request after the latest one succeeded", async () => {
    const { fetchPage, calls } = createControlledFetch();
    render(<OrdersConsole fetchPage={fetchPage} />);
    await settle(() => calls[0]!.resolve(pageWith("Initial")));

    fireEvent.change(statusSelect(), { target: { value: "paid" } });
    fireEvent.change(statusSelect(), { target: { value: "cancelled" } });

    await settle(() => calls[2]!.resolve(pageWith("Cancelled result")));
    await settle(() => calls[1]!.reject(new Error("Server exploded")));

    expect(screen.getByText("Cancelled result")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores the AbortError of a cancelled request", async () => {
    const { fetchPage, calls } = createControlledFetch();
    render(<OrdersConsole fetchPage={fetchPage} />);
    await settle(() => calls[0]!.resolve(pageWith("Initial")));

    fireEvent.change(statusSelect(), { target: { value: "paid" } });
    fireEvent.change(statusSelect(), { target: { value: "pending" } });
    await settle(() => calls[1]!.reject(new DOMException("The operation was aborted.", "AbortError")));
    // Checked before the latest response lands, so a later success cannot hide a flash of error.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(table().getAttribute("aria-busy")).toBe("true");

    await settle(() => calls[2]!.resolve(pageWith("Pending result")));

    expect(screen.getByText("Pending result")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error for the latest request and recovers with Retry", async () => {
    const { fetchPage, calls } = createControlledFetch();
    render(<OrdersConsole fetchPage={fetchPage} />);
    await settle(() => calls[0]!.reject(new Error("Network down")));

    expect(screen.getByRole("alert").textContent).toContain("Network down");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.query).toEqual(calls[0]!.query);
    await settle(() => calls[1]!.resolve(pageWith("Recovered")));
    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an empty state when nothing matches", async () => {
    const { fetchPage, calls } = createControlledFetch();
    render(<OrdersConsole fetchPage={fetchPage} />);
    await settle(() =>
      calls[0]!.resolve({ data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } }),
    );
    expect(screen.getByText("No orders match these filters.")).toBeTruthy();
  });

  it("aborts the in-flight request when the console unmounts", async () => {
    const { fetchPage, calls } = createControlledFetch();
    const { unmount } = render(<OrdersConsole fetchPage={fetchPage} />);
    expect(calls[0]!.signal.aborted).toBe(false);
    unmount();
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});

describe("OrdersConsole: pagination reset", () => {
  async function renderOnPage2() {
    const controlled = createControlledFetch();
    render(<OrdersConsole fetchPage={controlled.fetchPage} />);
    await settle(() => controlled.calls[0]!.resolve(pageWith("Page 1", 5)));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(controlled.calls[1]!.query.page).toBe(2);
    await settle(() => controlled.calls[1]!.resolve(pageWith("Page 2", 5)));
    return controlled;
  }

  const lastQuery = (calls: PendingCall[]) => calls[calls.length - 1]!.query;

  it("goes back to page 1 when status, sort field, direction or page size change", async () => {
    const changes: [string, string, keyof OrdersQuery][] = [
      ["Status", "paid", "status"],
      ["Sort by", "total", "sortBy"],
      ["Direction", "asc", "sortDir"],
      ["Rows", "50", "pageSize"],
    ];
    for (const [label, value, field] of changes) {
      const { calls } = await renderOnPage2();
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(calls).toHaveLength(3); // exactly one new request, already on page 1
      expect(lastQuery(calls).page).toBe(1);
      expect(String(lastQuery(calls)[field])).toBe(value);
      cleanup();
    }
  });

  it("debounces search into one request and resets to page 1", async () => {
    const { calls } = await renderOnPage2();
    const search = screen.getByLabelText("Search customer");
    fireEvent.change(search, { target: { value: "a" } });
    fireEvent.change(search, { target: { value: "al" } });
    fireEvent.change(search, { target: { value: " ali " } });
    expect(calls).toHaveLength(2); // nothing sent while typing

    await waitFor(() => expect(calls).toHaveLength(3));
    expect(lastQuery(calls)).toMatchObject({ search: "ali", page: 1 });
  });

  it("Clear filters restores the defaults on page 1", async () => {
    const { calls } = await renderOnPage2();
    fireEvent.change(statusSelect(), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(lastQuery(calls)).toEqual({ page: 1, pageSize: 25, search: "", status: "", sortBy: "createdAt", sortDir: "desc" });
  });
});

describe("OrdersConsole: create order", () => {
  it("refreshes the list after a successful create, still applying only the latest response", async () => {
    const { fetchPage, calls } = createControlledFetch();
    const createOrder: CreateOrder = async (order) => ({
      replayed: false,
      order: { ...order, id: 50_001, status: "pending", totalCents: 2_499, createdAt: "2026-10-21T09:00:00.000Z", items: [] },
    });
    render(<OrdersConsole fetchPage={fetchPage} createOrder={createOrder} />);
    await settle(() => calls[0]!.resolve(pageWith("Before create")));

    fireEvent.click(screen.getByRole("button", { name: "New order" }));
    fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "New Customer" } });
    fireEvent.change(screen.getByLabelText("Customer email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Product 1"), { target: { value: "Mouse" } });
    fireEvent.change(screen.getByLabelText("Unit price (SAR)"), { target: { value: "24.99" } });
    await settle(() => fireEvent.click(screen.getByRole("button", { name: "Create order" })));

    expect(screen.getByText("Order #50001 created.")).toBeTruthy();
    expect(calls).toHaveLength(2); // the list was requested again, same query
    expect(calls[1]!.query).toEqual(calls[0]!.query);

    // A status change while the refresh is in flight: the refresh is now stale.
    fireEvent.change(statusSelect(), { target: { value: "paid" } });
    await settle(() => calls[2]!.resolve(pageWith("Paid after create")));
    await settle(() => calls[1]!.resolve(pageWith("Stale refresh")));
    expect(screen.getByText("Paid after create")).toBeTruthy();
    expect(screen.queryByText("Stale refresh")).toBeNull();
  });
});
