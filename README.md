# Orders Console

Take-home assessment for SARH Business Solutions: a React + Node console for
browsing a large orders table (R1) and creating orders without duplicates (R2).

> **Status:** work in progress. Done: scaffold, database foundation, **R1** (orders list
> with stale-response protection) and **R2** (idempotent order creation). Not started yet:
> authentication and the security review fixes. This README describes only what exists.

> **Security warning (unfinished):** `GET` and `POST /api/orders` are currently
> **unauthenticated**, so R1 and R2 can be tested before the authentication stage. The API
> therefore listens on **127.0.0.1 only**. Do not expose it until authentication is done.

## Requirements

- Node.js **22.12+** (developed on Node 24.14.0, Windows 11)
- npm 10+ (developed with npm 11.9.0)
- No external services: SQLite runs in-process via `better-sqlite3`, which ships
  prebuilt binaries for common platforms (no compiler was needed on Windows x64).

## Setup and run

```bash
npm install            # installs server + client (npm workspaces)
cp .env.example .env   # optional: defaults work without it
npm run seed           # creates server/data/orders.db with 50,000 orders
npm run dev:server     # terminal 1: API on http://127.0.0.1:3001
npm run dev:client     # terminal 2: open http://localhost:5173
```

The server never creates, wipes or seeds data. If the database file is missing or its
schema is incomplete, it exits with a message telling you to run `npm run seed`.

## Commands (run from the repository root)

| Command | What it does |
|---|---|
| `npm run seed` | Drops and recreates all tables, then inserts 2 users and 50,000 orders in one transaction. Safe to re-run. |
| `npm test` | Server tests (`node:test`, temporary databases) and client tests (Vitest + jsdom). |
| `npm run test:r2` | Only the R2 duplicate-proof tests, including the two-process concurrency test. |
| `npm run benchmark` | Times the real R1 query code on the seeded database and prints the query plans. |
| `npm run dev:server` | API on http://127.0.0.1:3001 (loopback only) |
| `npm run dev:client` | UI on http://localhost:5173 (proxies `/api` to the API) |
| `npm run typecheck` | TypeScript check for server and client (including tests) |
| `npm run build` | Production build of the client |

## Demo users

Created by `npm run seed`. Only scrypt hashes are stored in the database.

| Role | Email | Password |
|---|---|---|
| admin | `admin@orders.test` | `Admin123!` |
| agent | `agent@orders.test` | `Agent123!` |

These are local demo credentials, not secrets. Login is not implemented yet. Until it is,
order creation acts as the agent (see "Limits of the guarantee" below).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | API port; the Vite proxy expects 3001. |
| `DATABASE_PATH` | `server/data/orders.db` | Relative paths resolve from the repository root. |
| `SIMULATED_LATENCY_MS` | `0` | Development aid: random 0..N ms delay on `/api/orders`, to reproduce out-of-order responses by hand. |

## R1 API: `GET /api/orders`

| Parameter | Values | Default |
|---|---|---|
| `page` | whole number 1..1,000,000 | `1` |
| `pageSize` | whole number 1..100 | `25` |
| `search` | substring of customer name or email; trimmed; max 100 characters; empty = no search | none |
| `status` | `pending`, `paid`, `shipped`, `delivered`, `cancelled`; empty = all | all |
| `sortBy` | `createdAt`, `total` | `createdAt` |
| `sortDir` | `asc`, `desc` | `desc` |

```json
{
  "data": [
    { "id": 50000, "customerName": "Omar Mansour", "customerEmail": "omar.mansour596@proton.me",
      "status": "delivered", "totalCents": 799, "createdAt": "2026-10-19T14:19:41.995Z" }
  ],
  "pagination": { "page": 1, "pageSize": 25, "total": 50000, "totalPages": 2000 }
}
```

- **Validation:** any invalid value, unknown parameter (e.g. a typo like `staus`) or
  repeated parameter returns `400 {"error": "Invalid query parameters", "details": [{"field", "message"}]}`.
  A page past the end returns `200` with an empty `data` array and the real `total`.
- **SQL safety:** every value is a bound parameter. `sortBy`/`sortDir` are looked up in
  fixed maps (`createdAt → created_at`, `desc → DESC`); request text never becomes SQL.
- **Stable order:** `ORDER BY <column> <dir>, id <dir>`, so equal dates or amounts never
  swap between requests and paging never repeats or skips a row.
- **Consistent totals:** the `COUNT(*)` and the page `SELECT` run in one read transaction,
  so they come from the same snapshot.
- **Errors:** unexpected failures return `500 {"error": "Internal server error"}` with no
  stack trace or SQL. The server logs the error but not the query string, which can
  contain customer names and emails.

### Search semantics

- Case-insensitive **substring** match on customer name **or** email (`LIKE '%term%'`).
- `%`, `_` and `\` in the term are escaped, so searching `100%` or `a_b` matches those
  characters literally.
- Case-insensitive for **ASCII letters only** (SQLite's built-in `LIKE`): `ali` matches
  `Ali`, but `émile` does not match `Émile`. A test documents this.
- A leading-wildcard `LIKE` cannot use a B-tree index, so search is a **scan** (see the
  measurements below).

## UI and stale-response protection

The console has a search box (debounced 300 ms), a status filter, sort field and direction,
Clear filters, Previous/Next, page size (25/50/100), and loading, error (with Retry) and
empty states. The table scrolls horizontally on narrow screens. Amounts are shown in SAR
(an assumption, because the data model has no currency) and dates in the viewer's local time.

**Page reset:** the page number and the filters live in one state object. Changing a filter
sets `page: 1` in the same update, so no request is ever sent for "new filter + old page".

**Latest request wins** ([client/src/orders/useOrders.ts](client/src/orders/useOrders.ts)):

1. Every request gets an id from a counter. A response, success or error, is applied
   only if its id is still the latest. The effect cleanup, which runs when the query
   changes or the component unmounts, marks the request obsolete and aborts it.
2. `AbortController` stops the browser waiting for obsolete requests. Abort alone is not
   relied on for correctness:
   - If a response has already arrived and its callback is queued, aborting does not stop
     that callback from running.
   - A fetch function can ignore the signal.
   - The server keeps processing an aborted request.

   The id check covers all three cases.
3. `loading` and `error` follow the same rule, so a stale response cannot end the
   loading state of the current request, and a stale error cannot replace a good result.
   While a new page loads, the previous rows stay visible but dimmed (`aria-busy="true"`).

### Reproducing the rapid-filter test

- **Automated:** `npm test` runs [client/src/orders/OrdersConsole.test.tsx](client/src/orders/OrdersConsole.test.tsx).
  It changes the status 3 times, resolves the responses newest-first, and checks that only
  the latest result is shown. It also checks that older requests were aborted, that stale
  errors and AbortErrors are ignored, and that the page resets to 1. The fake fetch in this
  test ignores the abort signal on purpose, so the test proves the id check works on its own.
- **By hand:** start the API with a random delay, e.g. `SIMULATED_LATENCY_MS=1500 npm run dev:server`
  (PowerShell: `$env:SIMULATED_LATENCY_MS=1500; npm run dev:server`). Then change the
  status filter three times quickly. The table must end on the last status you picked.

**Real-browser check:** I drove headless Chrome against the dev server with
`SIMULATED_LATENCY_MS=1500`, changing the status 3 times 40 ms apart, over 5 trials
(script kept outside the repo). In every trial both older requests ended as `AbortError`,
the latest returned `HTTP 200`, and every row in the table had the last status picked.
Typing `a`, `al`, `ali` sent exactly one request.

## R2 API: `POST /api/orders`

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 6ff0792d-1c3b-4b4e-9b1e-2f7a3c9d8e10

{
  "customerName": "Layla Hassan",
  "customerEmail": "layla@example.com",
  "items": [
    { "productName": "Wireless Mouse", "quantity": 2, "unitPriceCents": 2499 },
    { "productName": "USB-C Cable", "quantity": 3, "unitPriceCents": 999 }
  ]
}
```

```bash
curl -i -X POST http://127.0.0.1:3001/api/orders \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(node -p 'crypto.randomUUID()')" \
  -d '{"customerName":"Layla Hassan","customerEmail":"layla@example.com","items":[{"productName":"Wireless Mouse","quantity":2,"unitPriceCents":2499}]}'
```

| Response | When |
|---|---|
| `201 {"order": {...}}` | Order created. The server sets `status: "pending"` and computes `totalCents` (7,995 above). |
| `201` + header `Idempotent-Replayed: true` | Same key and same payload as an earlier request. The existing order is returned and nothing new is written. |
| `400 {"error": "Invalid order", "details": [{"field", "message"}]}` | Invalid body or `Idempotency-Key`. Nothing is written. |
| `409` | Same key, different payload. Nothing is written. |
| `410` | Same key and payload, but the order it created has since been deleted. It is **not** recreated. |
| `500 {"error": "Internal server error"}` | Unexpected failure. The transaction is rolled back, so nothing from the attempt is kept and the key is not consumed. |

### Validation rules (server; the client mirrors them for faster feedback)

- `customerName`: string, trimmed, 1–200 characters. `customerEmail`: string, trimmed,
  at most 254 characters, `something@something.tld` (a pragmatic check, not full RFC 5322).
- `items`: an array of **1–5** objects. `productName`: 1–200 characters.
  `quantity`: whole number 1–1,000. `unitPriceCents`: whole number 1–10,000,000.
- Numbers must be real JSON numbers and safe integers: `"2"`, `24.99`, `0`, negatives and
  `2^53` are all rejected. A string is never coerced; the phase-2 tests found that SQLite
  STRICT would coerce `"10.00"`.
- Unknown fields are rejected, so a client cannot send `totalCents`. **The total is always
  computed by the server** in integer cents. The bounds above cap it at 5 × 1,000 × 10,000,000
  = 5×10¹⁰ cents, far below `Number.MAX_SAFE_INTEGER`, so it cannot overflow. The code also
  asserts this.
- `Idempotency-Key` header: required, 16–100 characters of `A-Z a-z 0-9 - _`. The UI sends a UUID v4.

### Idempotency: how duplicates are prevented

All of this runs in **one SQLite transaction started with `BEGIN IMMEDIATE`**
([server/src/orders/createOrder.ts](server/src/orders/createOrder.ts)):

1. Compute the request fingerprint: SHA-256 of the validated, trimmed payload in a fixed
   field order. Key order and surrounding whitespace in the JSON do not change it.
2. Look up `(user_id, Idempotency-Key)` in `idempotency_keys`:
   - **found, same fingerprint, order exists** → replay that order (`201`, `Idempotent-Replayed: true`);
   - **found, different fingerprint** → `409`;
   - **found, `order_id` is NULL** (the order was deleted; the FK is `ON DELETE SET NULL`) → `410`;
   - **not found** → insert the order, its items and the key row, then commit.

Why each part is there:

- **`BEGIN IMMEDIATE`** takes SQLite's single write lock *before* the lookup. A concurrent
  request, even from another process, waits (`busy_timeout` 5 s), then sees the committed
  key and replays.
- **`PRIMARY KEY (user_id, idempotency_key)`** is the database-level guarantee. If two
  inserts ever raced, one would fail and its whole transaction (order and items included)
  would roll back.
- **One transaction** means the order, its items and the key record are saved together or
  not at all. A failed attempt does not burn the key.
- Everything lives in the database file, so a server restart changes nothing.

What I measured by breaking it on purpose. The first two rows used 40 concurrent requests
(5 keys × 8 copies) sent to two server processes sharing one database file:

| Variant | Responses | Orders created | Duplicate lines |
|---|---|---|---|
| Real code (`BEGIN IMMEDIATE`), 3 runs | 40 × `201` every run | 5 | 0 |
| Plain deferred transaction, 4 runs | 2–4 × `500` (`SQLITE_BUSY`) per run, rest `201` | 5 | 0 |

With the key lookup removed (PRIMARY KEY only), the in-process tests for a sequential
repeat and for 20 parallel copies both failed: repeats got `500` from
`SQLITE_CONSTRAINT_PRIMARYKEY` instead of a replay.

So the PRIMARY KEY plus the transaction is what makes a duplicate impossible, and
`BEGIN IMMEDIATE` is what makes concurrent duplicates get a correct *replay* instead of an
error. (A deferred transaction starts as a reader; when it tries to upgrade after another
process has committed, SQLite returns `SQLITE_BUSY` at once, and `busy_timeout` cannot help.)

### Limits of the guarantee

- **Scope:** "same user + same key" means one order. Two *different* keys with the same
  payload create two orders on purpose (a customer may really order the same thing twice).
  Duplicates typed in by hand under new keys are a product question, not something
  idempotency solves.
- **Temporary identity (until authentication):** there is no login yet, and the server never
  trusts a user id sent by the client. Every create request acts as the seeded agent
  (`agent@orders.test`), resolved on the server in
  [server/src/auth/temporaryIdentity.ts](server/src/auth/temporaryIdentity.ts). So today all
  keys share one scope. UUID v4 keys make accidental collisions negligible, and a collision
  with a different payload would get `409`, not a wrong order. The authentication stage
  replaces this with the user id from a verified token.
- **Not exposed:** the API listens on **127.0.0.1 only**. `POST /api/orders` is
  unauthenticated and must not be reachable from other machines until authentication exists.
- **Key lifetime:** key records are kept forever (one small row per order). There is no
  expiry window, so a very late retry still replays.
- **Replay returns the order as it is now** (re-read from the database), not a byte-for-byte
  copy of the first response.
- **One database:** the guarantee holds for every process using the same SQLite file. It
  would need rethinking for several databases or a sharded setup.

### The client's key lifecycle

[client/src/orders/CreateOrderForm.tsx](client/src/orders/CreateOrderForm.tsx):

- **Submit** validates the form, then creates one *attempt* = `{ new UUID key, exact payload }`.
- **Success** (`201`, replayed or not): the attempt ends, the form resets, and the list
  reloads through the same latest-request-wins hook as R1. The next order gets a new key.
- **Definite failure** (`400` / `409` / `410`): the server answered and wrote nothing new. The
  attempt ends, and server field errors appear next to the matching inputs.
- **Uncertain failure** (network error, 15 s timeout, or `5xx`): the attempt is kept and the
  form is **locked**, so the payload cannot change. **Retry** resends the same payload with
  the same key, which is safe. **Start a new order instead** explicitly drops the key and warns
  the user to check the list first, because the previous attempt may have been saved.
- Double submission is blocked twice: the button is disabled, and a ref guard covers two
  clicks in the same tick. This is UX only; the server is the guarantee.
- Prices are typed in SAR and converted to cents **from the text** (`"0.29"` → 29), never with
  `0.29 * 100`, which is `28.999999999999996`.

### Duplicate-proof tests

```bash
npm run test:r2     # R2 server tests only (in-process HTTP + two-process test)
npm test            # everything
```

- [server/test/createOrder.test.ts](server/test/createOrder.test.ts) covers, over real HTTP against a temporary database:
  - a valid create and the server-computed total;
  - 22 invalid-input cases plus key and body format checks;
  - a sequential replay;
  - **20 identical requests in parallel → exactly one order, with line numbers 1..n and no duplicate lines**;
  - **a client timeout while the server is still working, then a retry → still one order**;
  - 409 on a different payload, and separate orders for different keys;
  - 410 after a delete;
  - a trigger-forced failure on the second item → full rollback, then a clean retry;
  - a restart (new connection, new app) → replay.
- [server/test/createOrder.multiprocess.test.ts](server/test/createOrder.multiprocess.test.ts)
  starts **two server processes** on one database file and sends 40 concurrent requests
  (5 keys × 8 copies). It checks for exactly 5 orders, one creator per key, and no failed
  requests. Inside one Node process better-sqlite3 runs each transaction synchronously, so
  this two-process test is the one that actually exercises the database lock.
- [client/src/orders/CreateOrderForm.test.tsx](client/src/orders/CreateOrderForm.test.tsx)
  and [orderDraft.test.ts](client/src/orders/orderDraft.test.ts) cover validation, cents
  conversion, double-click, key reuse on retry (network error, timeout, 5xx), a new key only
  after an explicit "start over", server field errors, 409/410, and a list refresh after success.

**Real-browser check:** I drove headless Chrome against the dev servers with a script kept
outside the repo. A created order appeared on top of the refreshed list. A double-click sent
one POST. In the most important case, the browser's fetch was made to throw *after* the
server had saved the order (a lost response): the UI locked the form, the order already
existed in the database, Retry sent the same key, and the UI said
"Order #… was already saved; no duplicate was created". The order count stayed at 1. The
R1 rapid-filter check still passed in the same session.

## Data model

```
users            id PK, email UNIQUE (case-insensitive), password_hash, role ('admin'|'agent'), created_at
orders           id PK, customer_name, customer_email, status, total_cents INTEGER > 0, created_at (ISO-8601 UTC)
order_items      id PK, order_id FK -> orders ON DELETE CASCADE, line_no 1..5, product_name,
                 quantity > 0, unit_price_cents > 0, UNIQUE (order_id, line_no)
idempotency_keys PK (user_id, idempotency_key), request_hash, order_id FK -> orders ON DELETE SET NULL, created_at
```

- All tables are SQLite `STRICT`, so a value of the wrong type (e.g. `12.5` for cents) is
  rejected. Caveat found by the tests: STRICT still converts text that is losslessly an
  integer (`"10.00"` becomes `10`), so the API must validate JSON types itself.
- Money is stored as integer cents. `orders.total_cents` equals the sum of
  `quantity * unit_price_cents`. The code that writes orders enforces that rule (and the
  tests check it); it is not a database constraint.
- `UNIQUE (order_id, line_no)` with `line_no BETWEEN 1 AND 5` limits an order to five lines
  and makes a duplicated line impossible at the database level.
- `idempotency_keys` records one row per created order (see R2 below).

## Indexes

| Index | Serves |
|---|---|
| `idx_orders_created_at (created_at)` | no filter, sort by date |
| `idx_orders_total_cents (total_cents)` | no filter, sort by amount |
| `idx_orders_status_created_at (status, created_at)` | status filter, sort by date |
| `idx_orders_status_total (status, total_cents)` | status filter, sort by amount |

SQLite stores the rowid (`id`) at the end of every index entry, so each index is already
ordered by `(..., id)`. `EXPLAIN QUERY PLAN` shows no `TEMP B-TREE` sort for any list query.
The `id` in `ORDER BY` is still written explicitly. I checked this by removing it: the paging
test still passed, because today's plan happens to return ties in id order. The explicit
tie-breaker makes the order a guarantee rather than a side effect of the plan, and a test
now asserts it is present.

## Measured performance

`npm run benchmark` times the real `buildOrdersSql()` / `listOrders()` code on the seeded
database: 50,000 orders, Node v24.14.0, SQLite 3.53.4, Intel Core i7-10750H, 3 warm-up +
20 measured runs. Times are in ms (median / max) and cover the database only, without
HTTP or JSON. "listOrders()" means COUNT + page SELECT in one transaction, which is what
one API call runs.

| Query | Page | Total | Page SELECT | COUNT | listOrders() | Page plan |
|---|---:|---:|---:|---:|---:|---|
| newest first, page 1 | 1 | 50000 | 0.06 / 0.10 | 0.01 / 0.01 | 0.12 / 0.22 | SCAN USING INDEX idx_orders_created_at |
| newest first, last page | 2000 | 50000 | 1.13 / 2.66 | 0.01 / 0.01 | 1.20 / 1.36 | SCAN USING INDEX idx_orders_created_at |
| amount high→low, page 1 | 1 | 50000 | 0.05 / 0.07 | 0.01 / 0.05 | 0.11 / 0.64 | SCAN USING INDEX idx_orders_total_cents |
| amount low→high, last page | 2000 | 50000 | 1.29 / 1.45 | 0.01 / 0.03 | 1.31 / 1.50 | SCAN USING INDEX idx_orders_total_cents |
| status=pending, newest first, page 1 | 1 | 7535 | 0.05 / 0.07 | 0.23 / 0.24 | 0.34 / 0.37 | SEARCH USING INDEX idx_orders_status_created_at (status=?) |
| status=pending, amount low→high, last page | 302 | 7535 | 0.34 / 0.43 | 0.23 / 0.26 | 0.63 / 1.20 | SEARCH USING INDEX idx_orders_status_total (status=?) |
| search 'ali', newest first, page 1 | 1 | 2504 | 0.21 / 0.45 | 10.50 / 12.45 | 11.61 / 12.99 | SCAN USING INDEX idx_orders_created_at |
| search 'ali' + status=paid, amount high→low | 1 | 359 | 0.33 / 0.33 | 3.49 / 3.88 | 4.02 / 4.72 | SEARCH USING INDEX idx_orders_status_total (status=?) |
| search 'zzqx' (no match) | 1 | 0 | 13.36 / 15.08 | 6.69 / 8.88 | 20.88 / 25.66 | SCAN USING INDEX idx_orders_created_at |

Runs vary on a laptop. A second run right after this one gave similar figures for the
non-search rows, but up to about 2x on some search rows (e.g. COUNT for `'ali' + paid`:
3.49 ms, then 7.23 ms; no-match `listOrders()`: 20.88 ms, then 22.05 ms). Read the table
as orders of magnitude.

What the numbers say:

- Without search, every request measured under about 1.5 ms. The cost of OFFSET grows
  with the page number (about 1.2 ms on the last page).
- With search, the **exact total (`COUNT`) is most of the cost**: for `'ali'`, 10.5 ms of
  about 11.6 ms. The worst case measured is a no-match search at about 21 ms, because
  every row is scanned twice (once for the page, once for the count).
- Both scans grow linearly with the table. At 50,000 rows that does not justify FTS5 or a
  trigram index, so I added neither. At a much larger size, dropping the exact count for
  searches (showing "has more" instead) would be the first change, before FTS5.

## Current limitations

- **No authentication yet:** `GET` and `POST /api/orders` are open on 127.0.0.1, and order
  creation acts as the seeded agent (see the warning at the top and R2's limits).
- **Offset pagination drift:** if orders are inserted while someone is paging (newest
  first), rows shift, so a row can appear on two pages or be skipped. Changing a filter
  always restarts from page 1. See DECISIONS.md.
- **Search** is ASCII-only case-insensitive and a full scan (measured above).
- **Duplicated contract:** the client keeps its own copy of the statuses and response
  types (`client/src/api/orders.ts`) instead of a shared package.
- **Create-order key lifetime and scope:** see "Limits of the guarantee" in R2.
- **No schema migrations:** `IF NOT EXISTS` does not alter existing tables, so a schema
  change needs `npm run seed`.

## Still to do

- **Authentication** and the review of the supplied middleware: verified JWT with pinned
  algorithm and expiry, secret from the environment, strict Bearer parsing, hashed-password
  login, server-side role checks, all `/api/orders` routes protected, DELETE admin-only,
  and the client token-storage reasoning.
- **Write-ups:** the product question, "what I skipped and why", the third DECISIONS.md
  entry, and the recording or screenshots.
