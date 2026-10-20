import { Router } from "express";
import { getAuthUser, requireRole } from "../auth/middleware";
import type { Db } from "../db/connection";
import { createOrderIdempotently } from "./createOrder";
import { parseCreateOrderInput, parseIdempotencyKey } from "./createOrderInput";
import { parseOrdersQuery } from "./query";
import { listOrders } from "./repository";

// Mounted behind requireAuth (see app.ts): every handler here has a verified user.
export function createOrdersRouter(db: Db): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const parsed = parseOrdersQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.errors });
      return;
    }
    res.json(listOrders(db, parsed.query));
  });

  router.post("/", (req, res) => {
    const key = parseIdempotencyKey(req.get("Idempotency-Key"));
    const input = parseCreateOrderInput(req.body);
    if (!key.ok || !input.ok) {
      const details = [...(key.ok ? [] : key.errors), ...(input.ok ? [] : input.errors)];
      res.status(400).json({ error: "Invalid order", details });
      return;
    }

    const outcome = createOrderIdempotently(db, {
      // From the verified token, never from the request: keys are scoped per real user.
      userId: getAuthUser(req).id,
      idempotencyKey: key.value,
      input: input.value,
    });

    switch (outcome.kind) {
      case "created":
        res.status(201).json({ order: outcome.order });
        return;
      case "replayed":
        // Same response as the first time, marked so the client can say "already saved".
        res.status(201).set("Idempotent-Replayed", "true").json({ order: outcome.order });
        return;
      case "conflict":
        res.status(409).json({ error: "This Idempotency-Key was already used for a different order" });
        return;
      case "deleted":
        res.status(410).json({ error: "The order created with this Idempotency-Key has since been deleted" });
        return;
    }
  });

  // Admin only, checked here on the server. (In the supplied code the only check was a
  // React AdminOnly component, which anyone can bypass by calling the API directly.)
  // Items go with the order (ON DELETE CASCADE); its idempotency key row stays with
  // order_id = NULL, so a late retry of the original create gets 410, not a new order.
  router.delete("/:id", requireRole("admin"), (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
      res.status(400).json({ error: "Order id must be a positive whole number" });
      return;
    }
    const { changes } = db.prepare("DELETE FROM orders WHERE id = ?").run(Number(id));
    if (changes === 0) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
