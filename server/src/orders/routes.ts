import { Router } from "express";
import { findTemporaryActingUserId } from "../auth/temporaryIdentity";
import type { Db } from "../db/connection";
import { createOrderIdempotently } from "./createOrder";
import { parseCreateOrderInput, parseIdempotencyKey } from "./createOrderInput";
import { parseOrdersQuery } from "./query";
import { listOrders } from "./repository";

// TODO(auth stage): every /api/orders route must require a verified JWT, and the
// acting user must come from that token. Until then the API listens on 127.0.0.1 only.
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
      userId: findTemporaryActingUserId(db),
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

  return router;
}
