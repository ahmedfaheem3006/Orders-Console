import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type CreateOrder, type CreateOrderResult, type NewOrder } from "../api/orders";
import { CreateOrderForm } from "./CreateOrderForm";

// A fake createOrder whose calls the test settles by hand.
interface PendingCreate {
  payload: NewOrder;
  key: string;
  resolve: (result: CreateOrderResult) => void;
  reject: (error: unknown) => void;
}

function createControlledCreate() {
  const calls: PendingCreate[] = [];
  const createOrder: CreateOrder = (payload, key) =>
    new Promise((resolve, reject) => calls.push({ payload, key, resolve, reject }));
  return { createOrder, calls };
}

function sequentialKeys() {
  let n = 0;
  return () => `key-${++n}-0000000000000000`;
}

function created(id: number, replayed = false): CreateOrderResult {
  return {
    replayed,
    order: {
      id,
      customerName: "Sara Ali",
      customerEmail: "sara@example.com",
      status: "pending",
      totalCents: 4_998,
      createdAt: "2026-10-21T09:00:00.000Z",
      items: [{ lineNo: 1, productName: "Mouse", quantity: 2, unitPriceCents: 2_499 }],
    },
  };
}

function renderForm() {
  const controlled = createControlledCreate();
  const onCreated = vi.fn();
  render(
    <CreateOrderForm createOrder={controlled.createOrder} newKey={sequentialKeys()} onCreated={onCreated} onClose={() => {}} />,
  );
  return { ...controlled, onCreated };
}

function fillValidOrder() {
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Sara Ali" } });
  fireEvent.change(screen.getByLabelText("Customer email"), { target: { value: "sara@example.com" } });
  fireEvent.change(screen.getByLabelText("Product 1"), { target: { value: "Mouse" } });
  fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Unit price (SAR)"), { target: { value: "24.99" } });
}

const submitButton = () => screen.getByRole("button", { name: /Create order|Creating/ });

async function settle(action: () => void) {
  await act(async () => {
    action();
  });
}

afterEach(cleanup);

describe("CreateOrderForm", () => {
  it("shows field errors and sends nothing when the form is invalid", () => {
    const { calls } = renderForm();
    fireEvent.change(screen.getByLabelText("Customer email"), { target: { value: "not-an-email" } });
    fireEvent.change(screen.getByLabelText("Unit price (SAR)"), { target: { value: "24.999" } });
    fireEvent.click(submitButton());

    expect(screen.getByText("Enter the customer's name")).toBeTruthy();
    expect(screen.getByText("Enter a valid email, e.g. name@example.com")).toBeTruthy();
    expect(screen.getByText("Enter a product")).toBeTruthy();
    expect(screen.getByText("Price like 24.99 (max 100,000.00)")).toBeTruthy();
    expect(screen.getByLabelText("Customer email").getAttribute("aria-invalid")).toBe("true");
    expect(calls).toHaveLength(0);
  });

  it("shows the live total and sends integer cents", async () => {
    const { calls } = renderForm();
    fillValidOrder();
    expect(screen.getByTestId("order-total").textContent).toContain("49.98");
    fireEvent.click(submitButton());
    expect(calls[0]!.payload).toEqual({
      customerName: "Sara Ali",
      customerEmail: "sara@example.com",
      items: [{ productName: "Mouse", quantity: 2, unitPriceCents: 2_499 }],
    });
  });

  it("sends one request for a double-click and shows the submitting state", () => {
    const { calls } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    fireEvent.click(submitButton());
    fireEvent.submit(submitButton().closest("form")!); // even a direct second submit
    expect(calls).toHaveLength(1);
    expect(submitButton().textContent).toBe("Creating…");
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("after an uncertain failure, locks the form and retries with the SAME key and payload", async () => {
    const { calls, onCreated } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    await settle(() => calls[0]!.reject(new TypeError("Failed to fetch")));

    expect(screen.getByRole("alert").textContent).toContain("could not confirm whether the order was saved");
    expect(screen.getByLabelText("Customer name").matches(":disabled")).toBe(true); // payload cannot change (fieldset disabled)

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[1]!.payload).toEqual(calls[0]!.payload);

    await settle(() => calls[1]!.resolve(created(77, true)));
    expect(screen.getByRole("status").textContent).toBe("Order #77 was already saved; no duplicate was created.");
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("treats a timeout and a 5xx as uncertain too", async () => {
    const { calls } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    await settle(() => calls[0]!.reject(new DOMException("signal timed out", "TimeoutError")));
    expect(screen.getByRole("alert").textContent).toContain("did not answer in time");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle(() => calls[1]!.reject(new ApiError("Internal server error", 500)));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(new Set(calls.map((call) => call.key)).size).toBe(1);
  });

  it("uses a new key only after the user explicitly abandons the uncertain attempt", async () => {
    const { calls } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    await settle(() => calls[0]!.reject(new TypeError("Failed to fetch")));

    fireEvent.click(screen.getByRole("button", { name: "Start a new order instead" }));
    expect(screen.getByRole("status").textContent).toContain("may have been saved. Check the orders list");
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "3" } }); // editable again
    fireEvent.click(submitButton());

    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    expect(calls[1]!.payload.items[0]!.quantity).toBe(3);
  });

  it("on success resets the form, refreshes the list, and the next order gets a new key", async () => {
    const { calls, onCreated } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    await settle(() => calls[0]!.resolve(created(50_123)));

    expect(screen.getByRole("status").textContent).toBe("Order #50123 created.");
    expect(onCreated).toHaveBeenCalledWith(created(50_123).order);
    expect((screen.getByLabelText("Customer name") as HTMLInputElement).value).toBe("");

    fillValidOrder();
    fireEvent.click(submitButton());
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });

  it("shows server validation errors next to the right field", async () => {
    const { calls } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    await settle(() =>
      calls[0]!.reject(
        new ApiError("Invalid order", 400, [{ field: "items[0].quantity", message: "Must be between 1 and 1000" }]),
      ),
    );
    expect(screen.getByRole("alert").textContent).toBe("Invalid order");
    expect(screen.getByText("Must be between 1 and 1000")).toBeTruthy();
    expect(screen.getByLabelText("Customer name").matches(":disabled")).toBe(false);
  });

  it("shows 409 and 410 answers as definite errors and starts a new attempt afterwards", async () => {
    const { calls } = renderForm();
    fillValidOrder();
    fireEvent.click(submitButton());
    await settle(() =>
      calls[0]!.reject(new ApiError("The order created with this Idempotency-Key has since been deleted", 410)),
    );
    expect(screen.getByRole("alert").textContent).toContain("has since been deleted");

    fireEvent.click(submitButton());
    await settle(() => calls[1]!.reject(new ApiError("This Idempotency-Key was already used for a different order", 409)));
    expect(screen.getByRole("alert").textContent).toContain("already used for a different order");
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });
});
