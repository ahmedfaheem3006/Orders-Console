# Orders Console

Take-home assessment for SARH Business Solutions: a React + Node console for
browsing a large orders table (R1) and creating orders without duplicates (R2).

> **Status:** work in progress. Done so far: project scaffold and the database
> foundation (schema, seed, indexes, benchmark, tests). Not started yet:
> authentication, the R1 list, the R2 create flow. This README is updated
> stage by stage and only describes what exists.

## Requirements

- Node.js **22.12+** (developed on Node 24.14.0, Windows 11)
- npm 10+ (developed with npm 11.9.0)
- No external services: SQLite runs in-process via `better-sqlite3`, which ships
  prebuilt binaries for common platforms (no compiler was needed on Windows x64).

## Setup

```bash
npm install            # installs server + client (npm workspaces)
cp .env.example .env   # optional: defaults work without it
npm run seed           # creates server/data/orders.db with 50,000 orders
```

## Commands (run from the repository root)

| Command | What it does |
|---|---|
| `npm run seed` | Drops and recreates all tables, then inserts 2 users and 50,000 orders in one transaction. Safe to re-run. |
| `npm test` | Database tests (`node:test`) on a temporary database; the real one is never touched. |
| `npm run benchmark` | Times the planned R1 queries against the seeded database and prints the query plans. |
| `npm run dev:server` | API on http://localhost:3001 |
| `npm run dev:client` | UI on http://localhost:5173 (proxies `/api` to the API) |
| `npm run typecheck` | TypeScript check for server and client |
| `npm run build` | Production build of the client |

## Demo users

Created by `npm run seed`. Only scrypt hashes are stored in the database.

| Role | Email | Password |
|---|---|---|
| admin | `admin@orders.test` | `Admin123!` |
| agent | `agent@orders.test` | `Agent123!` |

These are local demo credentials, not secrets. Login is not implemented yet.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | API port; the Vite proxy expects 3001. |
| `DATABASE_PATH` | `server/data/orders.db` | Relative paths resolve from the repository root. |

## Data model

```
users            id PK, email UNIQUE (case-insensitive), password_hash, role ('admin'|'agent'), created_at
orders           id PK, customer_name, customer_email, status, total_cents INTEGER > 0, created_at (ISO-8601 UTC)
order_items      id PK, order_id FK -> orders ON DELETE CASCADE, line_no 1..5, product_name,
                 quantity > 0, unit_price_cents > 0, UNIQUE (order_id, line_no)
idempotency_keys PK (user_id, idempotency_key), request_hash, order_id FK -> orders ON DELETE SET NULL, created_at
```

- All tables are SQLite `STRICT`, so a value of the wrong type (e.g. `12.5` for cents) is rejected.
  Caveat found by the tests: STRICT still converts text that is losslessly an integer
  (`"10.00"` becomes `10`), so the API must validate JSON types itself.
- Money is stored as integer cents. `orders.total_cents` equals the sum of
  `quantity * unit_price_cents`; that rule is enforced by the code that writes
  orders (and checked by the tests), not by a database constraint.
- `UNIQUE (order_id, line_no)` with `line_no BETWEEN 1 AND 5` limits an order to five
  lines and makes a duplicated line impossible at the database level.
- `idempotency_keys` is created now but not used until R2.

## Indexes

| Index | Serves |
|---|---|
| `idx_orders_created_at (created_at)` | no filter, sort by date |
| `idx_orders_total_cents (total_cents)` | no filter, sort by amount |
| `idx_orders_status_created_at (status, created_at)` | status filter, sort by date |
| `idx_orders_status_total (status, total_cents)` | status filter, sort by amount |

SQLite appends the rowid (`id`) to every index entry, so each index is already ordered
by `(..., id)` and supports the `id` tie-breaker for stable ordering. I checked this with
`EXPLAIN QUERY PLAN`: `ORDER BY created_at DESC, id DESC` uses the index with no
`TEMP B-TREE` sort, with or without `id` listed in the index. A test keeps this true.

## Search semantics and measured performance

Planned R1 search: case-insensitive **substring** match on customer name OR email
(`LIKE '%term%'`). Limits:

- A B-tree index cannot serve a leading-wildcard `LIKE`. Search is a **scan**: SQLite walks
  the index for the chosen sort order and tests each row until the page is full.
- Common terms are fast because the page fills early. A term that matches nothing
  checks every row, so its cost grows linearly with the table.
- SQLite `LIKE` is case-insensitive for ASCII letters only.

`npm run benchmark` output on the seeded database (50,000 orders, 116,465 items),
Node v24.14.0, SQLite 3.53.4, Intel Core i7-10750H, page size 25,
3 warm-up + 20 measured runs. These are database times only, without HTTP or JSON.

| Query | Rows (or COUNT) | Median ms | Max ms | Plan |
|---|---:|---:|---:|---|
| newest first, page 1 | 25 | 0.05 | 0.08 | SCAN orders USING INDEX idx_orders_created_at |
| newest first, offset 25,000 | 25 | 0.64 | 0.79 | SCAN orders USING INDEX idx_orders_created_at |
| newest first, last page (offset 49,975) | 25 | 1.21 | 1.49 | SCAN orders USING INDEX idx_orders_created_at |
| amount high→low, page 1 | 25 | 0.05 | 0.08 | SCAN orders USING INDEX idx_orders_total_cents |
| status=pending, newest first, page 1 | 25 | 0.05 | 0.06 | SEARCH orders USING INDEX idx_orders_status_created_at (status=?) |
| status=pending, amount low→high, offset 7,000 | 25 | 0.36 | 0.49 | SEARCH orders USING INDEX idx_orders_status_total (status=?) |
| search 'ali', newest first, page 1 | 25 | 0.22 | 0.27 | SCAN orders USING INDEX idx_orders_created_at |
| search 'ali' + status=paid, amount high→low | 25 | 0.34 | 0.36 | SEARCH orders USING INDEX idx_orders_status_total (status=?) |
| search 'zzqx' (no match), newest first | 0 | 13.33 | 14.09 | SCAN orders USING INDEX idx_orders_created_at |
| COUNT all orders | 50000 | 0.01 | 0.01 | SCAN orders USING COVERING INDEX idx_orders_total_cents |
| COUNT status=pending | 7535 | 0.24 | 0.40 | SEARCH orders USING COVERING INDEX idx_orders_status_total (status=?) |
| COUNT search 'ali' | 2504 | 11.93 | 13.77 | SCAN orders |

What these numbers say:

- The worst case is a full-scan search at about 13 ms. At 50,000 rows that does not justify
  FTS5 or a trigram index. Because the cost is linear, it would need revisiting at a
  much larger scale.
- OFFSET cost grows with the offset, but even the last page measured about 1.2 ms here.
- A `COUNT(*)` for a search is also a full scan (about 12 ms). That matters if the UI
  shows a total for every search.

## Not done yet

Authentication and the security review fixes, the R1 list API and UI, the R2 create
flow and duplicate proof, DECISIONS.md, the AI-assistance disclosure, the product
question, and "what I skipped and why". These sections are added as each stage lands.
