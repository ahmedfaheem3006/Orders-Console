import { Router } from "express";
import type { Db } from "../db/connection";
import { parseOrdersQuery } from "./query";
import { listOrders } from "./repository";

// TODO(auth stage): every /api/orders route must require a verified JWT.
// GET is temporarily public for R1 testing on localhost only.
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

  return router;
}
