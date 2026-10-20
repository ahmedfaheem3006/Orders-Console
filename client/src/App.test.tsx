import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Login, Session } from "./api/auth";

// App wires the real API client to a stubbed global fetch, so these tests cover the
// whole path: session in memory -> Authorization header -> 401/403 handling.

function sessionFor(role: "admin" | "agent", expiresInMs = 3_600_000): Session {
  return {
    token: `${role}.token.sig`,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    user: { id: role === "admin" ? 1 : 2, email: `${role}@orders.test`, role },
  };
}

const PAGE = {
  data: [{ id: 42, customerName: "Layla Hassan", customerEmail: "layla@example.com", status: "paid", totalCents: 1000, createdAt: "2026-10-01T10:00:00.000Z" }],
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
};

// Answers /api/orders with PAGE, or with `listStatus` if given.
function stubApi(options: { listStatus?: number; deleteStatus?: number } = {}) {
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, authorization: new Headers(init.headers).get("Authorization") });
      if (method === "DELETE") return new Response(null, { status: options.deleteStatus ?? 204 });
      const status = options.listStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? PAGE : { error: "Invalid or expired token" }), { status });
    }),
  );
  return calls;
}

async function signIn(session: Session) {
  const login = vi.fn<Login>(async () => session);
  render(<App login={login} />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: session.user.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Secret123!" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App session", () => {
  it("starts at the login screen and makes no API calls without a session", () => {
    const calls = stubApi();
    render(<App login={vi.fn<Login>()} />);
    expect(screen.getByRole("heading", { name: "Orders Console" })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("after login, loads orders with the Bearer token and shows who is signed in", async () => {
    const calls = stubApi();
    await signIn(sessionFor("agent"));
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    expect(calls[0]).toMatchObject({ method: "GET", authorization: "Bearer agent.token.sig" });
    expect(screen.getByText("agent@orders.test")).toBeTruthy();
  });

  it("returns to the login screen with a notice when the API answers 401", async () => {
    stubApi({ listStatus: 401 });
    await signIn(sessionFor("agent"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Your session has expired"));
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("returns to the login screen when the token's expiry time passes", async () => {
    stubApi();
    await signIn(sessionFor("agent", 150));
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Your session has expired. Please sign in again.")).toBeTruthy(), { timeout: 2000 });
  });

  it("logs out by dropping the in-memory session; nothing is written to web storage", async () => {
    const calls = stubApi();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await signIn(sessionFor("agent"));
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByText("Layla Hassan")).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    const callsAtLogout = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(callsAtLogout); // no further requests after logout
  });
});

describe("App roles", () => {
  it("hides Delete from agents", async () => {
    stubApi();
    await signIn(sessionFor("agent"));
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Delete order #42" })).toBeNull();
  });

  it("lets an admin delete after confirming, then reloads the list", async () => {
    const calls = stubApi();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await signIn(sessionFor("admin"));
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete order #42" })));

    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ url: "/api/orders/42", authorization: "Bearer admin.token.sig" });
    await waitFor(() => expect(screen.getByText("Order #42 deleted.")).toBeTruthy());
    expect(calls.filter((c) => c.method === "GET").length).toBe(2); // initial load + reload
  });

  it("shows the server's 403 even if the button was somehow available", async () => {
    stubApi({ deleteStatus: 403 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await signIn(sessionFor("admin")); // e.g. demoted in the database after signing in
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete order #42" })));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You do not have permission to delete orders."));
    expect(screen.getByText("admin@orders.test")).toBeTruthy(); // still signed in
  });

  it("does nothing when the admin cancels the confirmation", async () => {
    const calls = stubApi();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await signIn(sessionFor("admin"));
    await waitFor(() => expect(screen.getByText("Layla Hassan")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete order #42" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
