import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api/http";
import type { CreateOrder, CreatedOrder, NewOrder } from "../api/orders";
import { formatAmount } from "./format";
import {
  draftTotalCents,
  emptyDraft,
  emptyItem,
  MAX_ITEMS,
  validateDraft,
  type DraftErrors,
  type ItemDraft,
  type OrderDraft,
} from "./orderDraft";

// One logical submission: the exact payload sent and the key that identifies it.
// It lives until the outcome is KNOWN (success, or a definite rejection), so every
// retry of an uncertain attempt resends the same payload with the same key.
interface Attempt {
  key: string;
  payload: NewOrder;
}

type Phase =
  | { name: "editing"; notice?: string }
  | { name: "submitting" }
  | { name: "succeeded"; orderId: number; replayed: boolean }
  | { name: "failed"; message: string } // the server answered: nothing was saved
  | { name: "uncertain"; message: string }; // no clear answer: the order may or may not exist

interface CreateOrderFormProps {
  onCreated: (order: CreatedOrder) => void;
  onClose: () => void;
  createOrder: CreateOrder; // bound to the session token by App; a fake in tests
  newKey?: () => string; // injectable for tests
}

export function CreateOrderForm({
  onCreated,
  onClose,
  createOrder,
  newKey = () => crypto.randomUUID(),
}: CreateOrderFormProps) {
  const [draft, setDraft] = useState<OrderDraft>(emptyDraft);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [phase, setPhase] = useState<Phase>({ name: "editing" });
  const attempt = useRef<Attempt | null>(null);
  // A ref, not state: two clicks in the same tick both see it immediately.
  const inFlight = useRef(false);

  const locked = phase.name === "submitting" || phase.name === "uncertain";

  async function send(current: Attempt) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ name: "submitting" });
    try {
      const result = await createOrder(current.payload, current.key);
      attempt.current = null;
      setDraft(emptyDraft());
      setErrors({});
      setPhase({ name: "succeeded", orderId: result.order.id, replayed: result.replayed });
      onCreated(result.order);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // 400 invalid, 409 key conflict, 410 order deleted: a definite answer, and no
        // new order was written. The next submit is a new logical attempt with a new key.
        attempt.current = null;
        setErrors(Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])));
        setPhase({ name: "failed", message: error.message });
      } else {
        // Timeout, network error or 5xx: keep the attempt (same key, same payload) for Retry.
        // fetch rejects with a DOMException named "TimeoutError" when AbortSignal.timeout fires;
        // check the name, since DOMException is not an Error subclass in every environment.
        const timedOut = (error as { name?: unknown } | null)?.name === "TimeoutError";
        setPhase({ name: "uncertain", message: timedOut ? "The server did not answer in time." : "The connection failed." });
      }
    } finally {
      inFlight.current = false;
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    const { payload, errors: found } = validateDraft(draft);
    setErrors(found);
    if (!payload) return;
    attempt.current = { key: newKey(), payload };
    void send(attempt.current);
  }

  function retry() {
    if (attempt.current) void send(attempt.current);
  }

  // Explicitly abandon an uncertain attempt. Its key is dropped, so the next submit
  // is treated as a NEW order: the user is told to check the list first.
  function startOver() {
    attempt.current = null;
    setPhase({
      name: "editing",
      notice: "The previous attempt may have been saved. Check the orders list before submitting again.",
    });
  }

  function updateDraft(change: Partial<OrderDraft>, field?: string) {
    setDraft((current) => ({ ...current, ...change }));
    if (field && errors[field]) setErrors(({ [field]: _removed, ...rest }) => rest);
    if (phase.name === "succeeded" || phase.name === "failed") setPhase({ name: "editing" });
  }

  function updateItem(index: number, change: Partial<ItemDraft>, field: string) {
    updateDraft({ items: draft.items.map((item, i) => (i === index ? { ...item, ...change } : item)) }, `items[${index}].${field}`);
  }

  function removeItem(index: number) {
    updateDraft({ items: draft.items.filter((_, i) => i !== index) });
    // Item errors are keyed by index, which just shifted: drop them; the next submit recomputes.
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !field.startsWith("items"))));
  }

  const fieldProps = (field: string) => ({
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `${field}-error` : undefined,
  });
  const fieldError = (field: string) =>
    errors[field] ? (
      <span className="field-error" id={`${field}-error`}>
        {errors[field]}
      </span>
    ) : null;

  return (
    <section className="create-order" aria-labelledby="create-order-title">
      <div className="create-order-header">
        <h2 id="create-order-title">New order</h2>
        <button type="button" className="button-secondary" onClick={onClose} disabled={locked}>
          Close
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={locked}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="customerName">Customer name</label>
              <input
                id="customerName"
                value={draft.customerName}
                maxLength={200}
                onChange={(e) => updateDraft({ customerName: e.target.value }, "customerName")}
                {...fieldProps("customerName")}
              />
              {fieldError("customerName")}
            </div>
            <div className="field">
              <label htmlFor="customerEmail">Customer email</label>
              <input
                id="customerEmail"
                type="email"
                value={draft.customerEmail}
                maxLength={254}
                onChange={(e) => updateDraft({ customerEmail: e.target.value }, "customerEmail")}
                {...fieldProps("customerEmail")}
              />
              {fieldError("customerEmail")}
            </div>
          </div>

          <div className="items" role="group" aria-label="Items">
            {draft.items.map((item, index) => (
              <div className="item-row" key={item.key}>
                <div className="field field-product">
                  <label htmlFor={`product-${item.key}`}>Product {index + 1}</label>
                  <input
                    id={`product-${item.key}`}
                    value={item.productName}
                    maxLength={200}
                    onChange={(e) => updateItem(index, { productName: e.target.value }, "productName")}
                    {...fieldProps(`items[${index}].productName`)}
                  />
                  {fieldError(`items[${index}].productName`)}
                </div>
                <div className="field field-qty">
                  <label htmlFor={`quantity-${item.key}`}>Qty</label>
                  <input
                    id={`quantity-${item.key}`}
                    inputMode="numeric"
                    value={item.quantity}
                    onChange={(e) => updateItem(index, { quantity: e.target.value }, "quantity")}
                    {...fieldProps(`items[${index}].quantity`)}
                  />
                  {fieldError(`items[${index}].quantity`)}
                </div>
                <div className="field field-price">
                  <label htmlFor={`price-${item.key}`}>Unit price (SAR)</label>
                  <input
                    id={`price-${item.key}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={item.unitPrice}
                    onChange={(e) => updateItem(index, { unitPrice: e.target.value }, "unitPriceCents")}
                    {...fieldProps(`items[${index}].unitPriceCents`)}
                  />
                  {fieldError(`items[${index}].unitPriceCents`)}
                </div>
                <button
                  type="button"
                  className="button-secondary button-remove"
                  aria-label={`Remove product ${index + 1}`}
                  disabled={draft.items.length === 1}
                  onClick={() => removeItem(index)}
                >
                  Remove
                </button>
              </div>
            ))}
            {fieldError("items")}
            <button
              type="button"
              className="button-secondary"
              disabled={draft.items.length >= MAX_ITEMS}
              onClick={() => updateDraft({ items: [...draft.items, emptyItem()] })}
            >
              Add item
            </button>
          </div>
        </fieldset>

        <div className="create-order-footer">
          <p className="order-total">
            Total <strong data-testid="order-total">{formatAmount(draftTotalCents(draft))}</strong>
            <span className="muted"> · calculated again by the server</span>
          </p>
          <button type="submit" disabled={locked}>
            {phase.name === "submitting" ? "Creating…" : "Create order"}
          </button>
        </div>
      </form>

      {phase.name === "succeeded" && (
        <p className="message message-success" role="status">
          {phase.replayed
            ? `Order #${phase.orderId} was already saved; no duplicate was created.`
            : `Order #${phase.orderId} created.`}
        </p>
      )}
      {phase.name === "failed" && (
        <p className="message message-error" role="alert">
          {phase.message}
        </p>
      )}
      {phase.name === "editing" && phase.notice && (
        <p className="message message-warning" role="status">
          {phase.notice}
        </p>
      )}
      {phase.name === "uncertain" && (
        <div className="message message-warning" role="alert">
          <p>
            <strong>We could not confirm whether the order was saved.</strong> {phase.message} Retrying is safe: it
            sends the same request with the same key, so it cannot create a duplicate.
          </p>
          <div className="message-actions">
            <button type="button" onClick={retry}>
              Retry
            </button>
            <button type="button" className="button-secondary" onClick={startOver}>
              Start a new order instead
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
