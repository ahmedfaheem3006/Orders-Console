# Orders Console

A small orders console built for the SARH Business Solutions take-home assessment (Junior track).
Agents can search a list of 50,000 seeded orders and create new orders without creating duplicates.
It is a local development project, not a production-ready system.

## Tech stack

- Client: React 19, Vite, TypeScript, plain CSS
- Server: Node.js, Express 5, TypeScript
- Database: SQLite on disk (better-sqlite3)
- Auth: JWT (jsonwebtoken) and scrypt password hashes (Node's built-in crypto)
- Tests: node:test for the server, Vitest and Testing Library for the client

## Setup and run

You need Node.js 22.12 or newer.

```bash
npm install
npm run setup        # creates .env with a random JWT_SECRET (does not overwrite an existing .env)
npm run seed         # creates server/data/orders.db with 50,000 orders and 2 users
npm run dev:server   # terminal 1: API on http://127.0.0.1:3001
npm run dev:client   # terminal 2: open http://localhost:5173
```

Demo users (local test passwords):

| Email | Password | Role |
|---|---|---|
| admin@orders.test | Admin123! | admin: list, create and delete orders |
| agent@orders.test | Agent123! | agent: list and create orders |

`npm run seed` resets the database every time. The server will not start without a valid
`JWT_SECRET` or a seeded database, and it prints what to run instead.

## Tests

```bash
npm test             # all server and client tests
npm run test:r2      # only the R2 duplicate tests
npm run test:auth    # only the login, JWT and role tests
npm run typecheck
npm run build
npm run benchmark    # times the list queries on the seeded database
```

Screenshots of the app and the duplicate test are in [evidence/](evidence/).

## R1: orders list

- `GET /api/orders` takes `page`, `pageSize` (25 by default, max 100), `search`, `status`,
  `sortBy` (`createdAt` or `total`) and `sortDir` (`asc` or `desc`). Invalid values return 400.
- Pagination is done on the server with `LIMIT/OFFSET`, so the browser never gets the whole table.
  Every sort ends with `id`, so orders with the same date or amount always keep the same order.
- Search is a case-insensitive "contains" match on customer name or email (`LIKE '%term%'`).
  `%` and `_` in the search text are treated as normal characters. Case-insensitivity only works
  for ASCII letters (SQLite's default).
- Indexes: `(created_at)`, `(total_cents)`, `(status, created_at)` and `(status, total_cents)`.
  `EXPLAIN QUERY PLAN` shows each list query uses one of them with no extra sort step.
  A `'%term%'` search cannot use an index, so it scans the table.
- Measured with `npm run benchmark` on my laptop (times vary between runs): a list request
  without search takes about 0.1–2 ms in the database; the slowest case, a search with no
  matches, takes about 20–30 ms.
- Stale results: every request gets an id, and only the latest one may update the table,
  the loading state or the error. Older requests are also cancelled with `AbortController`.
  AbortController alone is not enough, because a response can already be on its way when
  the abort happens. The filters and the page are one state object, so changing a filter
  goes back to page 1 in the same update.
- Rapid-filter check: `client/src/orders/OrdersConsole.test.tsx` changes the status three
  times and returns the responses newest-first; only the last result is shown. To try it by
  hand, start the API with a random delay (`SIMULATED_LATENCY_MS=1500 npm run dev:server`, or
  in PowerShell `$env:SIMULATED_LATENCY_MS=1500; npm run dev:server`) and change the status
  filter quickly.

## R2: create an order without duplicates

- The form validates on the client, and the server validates everything again. It accepts
  1–5 items, whole-number quantities and prices in cents, and rejects unknown fields. The
  server calculates the total; the client cannot send one.
- The client creates one `Idempotency-Key` (a UUID) per submission. After a timeout or network
  error the form locks and "Retry" sends the same body with the same key.
- The server handles the key, the order, the items and the key record in one
  `BEGIN IMMEDIATE` transaction. `(user_id, idempotency_key)` is the primary key of the
  key table, so the database itself refuses a second record for the same key.
- Same key and same body: the first order is returned again (header `Idempotent-Replayed: true`).
  Same key with a different body: 409. If that order was deleted later: 410, and it is not created again.
- Proof: `npm run test:r2` sends 20 identical requests in parallel and checks that exactly one
  order and one set of items exist. Another test does the same with two server processes on
  one database file. There are also tests for a timeout followed by a retry, a forced database
  error (everything rolls back), and a server restart.

The reasons for these choices are in [DECISIONS.md](DECISIONS.md).

## Security review of the supplied auth code

Problems in the supplied `auth.ts` / `routes.ts`, and what I changed:

1. `jwt.decode` does not check the signature, so anyone can make their own admin token.
   Now `jwt.verify` checks it with the secret.
2. The secret is written in the code. Now it comes from `JWT_SECRET` in `.env`, and the server
   refuses to start if it is missing, shorter than 32 characters, or the old `sarh-secret-2026`.
3. Any signing algorithm is allowed. Now only HS256 is accepted (`alg: none` is rejected).
4. Tokens never expire. Now they expire after 1 hour, and a token without `exp` is rejected.
5. The token is also read from `?token=` in the URL, where it ends up in logs and browser
   history. Now it is read only from the `Authorization: Bearer <token>` header, with a strict
   format check.
6. The role is taken from the token. Now the token only holds the user id, and the user and
   role are loaded from the database on every request. A deleted user gets 401.
7. Delete is only "protected" by a React component. Now the server checks the role, and an
   agent gets 403.
8. Login compares plain-text passwords stored in the database. Now passwords are stored as
   salted scrypt hashes and compared in constant time.
9. Login passes `req.body.email` and `req.body.password` straight into the query. With an ORM
   like Prisma, a password such as `{"not": ""}` could match any user. Now only string email
   and password are accepted, and any other field (such as `role`) is rejected.
10. There is no limit on login attempts. Now 5 failed attempts per email and IP in 15 minutes
    return 429.
11. The delete route does not validate `:id` and always answers `{ ok: true }`. Now a bad id
    gets 400, a missing order 404, and a successful delete 204.

Other small fixes: every invalid token (bad signature, expired, wrong claims, deleted user)
gets the same 401 message, so the reason is not revealed, and errors are returned as JSON
without stack traces. The tests are in `server/test/auth.test.ts`.

**Token storage:** the token is kept only in memory (React state) and sent in the
`Authorization` header. This protects against CSRF, because the browser never sends the
token by itself, and the token is never written to localStorage, sessionStorage or a cookie.
It does not protect against XSS: a script running in the page can still act as the user while
they are logged in. The downside is that a page reload logs the user out.

## Product question: "Delete all cancelled orders"

First I would ask why: is the list too cluttered, is it about performance, or is there a rule
that says the data must be removed? I would also ask if anyone still needs cancelled orders for
refunds, reports or customer questions. Deleting is permanent, so we would lose that history.
If she can't answer, I would suggest hiding cancelled orders by default (with a filter to show
them) or archiving them, not a bulk delete.

## Trade-offs, limitations and skipped work

- I skipped the optional tasks O1 and O2 to keep the focus on the required parts.
- Offset pagination: if new orders come in while someone is paging, rows can move between pages.
- Search scans the table. That is fine for 50,000 rows but would need a different approach
  (for example full-text search) for much more data.
- Logout only removes the token from the browser. The token itself stays valid until it
  expires (at most 1 hour), because there is no revocation list.
- The login rate limit is kept in memory and resets when the server restarts.
- The API uses plain HTTP and only listens on 127.0.0.1. It is not set up for deployment.
- There are no database migrations. A schema change means running `npm run seed` again.
- Prices are shown in SAR. This is an assumption, because the data has no currency column.
- No Docker, deployment or component library, since the brief does not need them.

## AI usage

I used Claude Code and ChatGPT during this assessment. Details are in [DECISIONS.md](DECISIONS.md#ai-usage).
