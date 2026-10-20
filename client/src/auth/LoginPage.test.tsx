import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Login, Session } from "../api/auth";
import { ApiError } from "../api/http";
import { LoginPage } from "./LoginPage";

const SESSION: Session = {
  token: "a.b.c",
  expiresAt: "2026-10-21T12:00:00.000Z",
  user: { id: 2, email: "agent@orders.test", role: "agent" },
};

function renderLogin(login: Login, notice: string | null = null) {
  const onLoggedIn = vi.fn();
  render(<LoginPage login={login} onLoggedIn={onLoggedIn} notice={notice} />);
  return { onLoggedIn };
}

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}
const submit = () => screen.getByRole("button", { name: /Sign in|Signing in/ });

afterEach(cleanup);

describe("LoginPage", () => {
  it("validates the fields before sending anything", () => {
    const login = vi.fn<Login>();
    renderLogin(login);
    fireEvent.click(submit());
    expect(screen.getByText("Enter your email")).toBeTruthy();
    expect(screen.getByText("Enter your password")).toBeTruthy();

    fill("not-an-email", "x");
    fireEvent.click(submit());
    expect(screen.getByText("Enter a valid email address")).toBeTruthy();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect(login).not.toHaveBeenCalled();
  });

  it("shows a loading state, sends trimmed email and exact password, and hands over the session", async () => {
    let resolve!: (session: Session) => void;
    const login = vi.fn<Login>(() => new Promise((r) => (resolve = r)));
    const { onLoggedIn } = renderLogin(login);
    fill("  agent@orders.test ", " Agent123! ");
    fireEvent.click(submit());

    expect(login).toHaveBeenCalledWith("agent@orders.test", " Agent123! ");
    expect(submit().textContent).toBe("Signing in…");
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(SESSION));
    expect(onLoggedIn).toHaveBeenCalledWith(SESSION);
  });

  it("shows one generic message for wrong credentials and clears the password", async () => {
    const login = vi.fn<Login>(() => Promise.reject(new ApiError("Invalid email or password", 401)));
    renderLogin(login);
    fill("agent@orders.test", "wrong");
    await act(async () => fireEvent.click(submit()));
    expect(screen.getByRole("alert").textContent).toBe("Invalid email or password.");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("explains rate limiting and network failures", async () => {
    const login = vi
      .fn<Login>()
      .mockRejectedValueOnce(new ApiError("Too many login attempts. Try again later.", 429))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderLogin(login);
    fill("agent@orders.test", "x");
    await act(async () => fireEvent.click(submit()));
    expect(screen.getByRole("alert").textContent).toContain("Too many login attempts");

    fill("agent@orders.test", "x");
    await act(async () => fireEvent.click(submit()));
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the server");
  });

  it("shows why the user was signed out", () => {
    renderLogin(vi.fn<Login>(), "Your session has expired. Please sign in again.");
    expect(screen.getByRole("status").textContent).toBe("Your session has expired. Please sign in again.");
  });
});
