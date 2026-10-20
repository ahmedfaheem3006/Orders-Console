import type { Db } from "../db/connection";

// TEMPORARY, until the authentication stage replaces it with the id from a verified JWT.
//
// Idempotency keys are scoped per user (PRIMARY KEY (user_id, idempotency_key)), so
// creating an order needs a user id. There is no login yet, and the server must never
// trust a user id sent by the client. So every create request acts as the seeded demo
// agent, resolved here on the server. This is not authentication: the server listens
// on 127.0.0.1 only, so the endpoint cannot be reached from another machine.
export const TEMPORARY_ACTING_USER_EMAIL = "agent@orders.test";

export function findTemporaryActingUserId(db: Db): number {
  const id = db.prepare("SELECT id FROM users WHERE email = ?").pluck().get(TEMPORARY_ACTING_USER_EMAIL) as
    | number
    | undefined;
  if (id === undefined) {
    throw new Error(`Temporary acting user ${TEMPORARY_ACTING_USER_EMAIL} not found. Run "npm run seed".`);
  }
  return id;
}
