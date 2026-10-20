# Decisions

> In progress: two of the three decisions are written. The third will be added with the
> authentication stage.

## 1. Offset pagination with an exact total, not keyset (cursor) pagination

**Decision:** the list uses `page`/`pageSize` (max 100) with `LIMIT/OFFSET`, an exact `COUNT(*)`, and `id` as a tie-breaker in every `ORDER BY`.
**Alternative considered:** keyset pagination: the client sends the last row's `(sort value, id)` and the server returns rows after it. Its cost does not grow with depth, and new orders do not shift pages.
**Why I rejected it:** agents work with "page X of Y" and a total, and keyset gives neither without the same `COUNT`. It also needs an opaque cursor per sort field and direction, which is more code to get wrong.
The main benefit of keyset did not show up at this size: the last page (OFFSET 49,975) measured about 1.2 ms in `npm run benchmark`.
**Cost I accept:** if orders are inserted while an agent pages through "newest first", rows shift by one, so a row can repeat or be skipped across pages. Changing any filter restarts from page 1.
**When I would revisit:** OFFSET and the exact search count both grow linearly. If the table grows by orders of magnitude, I would move to keyset, or drop the exact count for searches, before reaching for anything heavier.

## 2. R2: a client-generated Idempotency-Key, recorded in the same transaction as the order

**Decision:** each logical submission gets a UUID key. In one `BEGIN IMMEDIATE` transaction the server looks up `(user, key)` and either replays the order (same SHA-256 payload fingerprint), returns 409 (different payload) or 410 (order deleted), or inserts the order, its items and the key row together. `PRIMARY KEY (user_id, idempotency_key)` is the backstop.
**Alternative considered:** de-duplicating on content: reject an order whose customer and items match one created in the last few minutes, with no key at all.
**Why I rejected it:** content cannot tell a retry from a real second order (a customer can order the same thing twice), and any time window is arbitrary: too short lets slow retries through, too long blocks real orders. A key identifies the *attempt*, so it is exact for retries and never blocks a deliberate repeat.
**Trade-offs:** the client must keep the key across retries and must not let the payload change while the outcome is unknown, which is why the form locks. Key rows are kept forever.
**Failures handled:** a crash mid-write rolls everything back without consuming the key; a lost response or timeout is retried with the same key and replays; concurrent copies wait for the write lock and replay. Measured across two processes: 40/40 `201` and exactly one order per key. With a plain deferred transaction, 2–4 of 40 requests failed with `SQLITE_BUSY`, though there were still no duplicates.
**Limits:** one SQLite database. Until authentication, all requests share one server-side identity. A user who explicitly abandons an uncertain attempt and resubmits under a new key can create a second order; the UI warns them to check the list first.

## AI assistance

> **To be completed by me (the candidate) before submission. Do not treat this section as final.**

- **Claude Code (Anthropic):** _describe what I used it for._ Commits it helped write carry a `Co-Authored-By: Claude` trailer.
- **ChatGPT:** _describe what I actually used it for._
- **What I decided or changed myself:** _list it here._
