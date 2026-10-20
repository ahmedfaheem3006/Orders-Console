# Decisions

## 1. Substring search with offset pagination

- **Decision:** search is a case-insensitive `LIKE '%term%'` on name and email. The list uses `page`/`pageSize` with `LIMIT/OFFSET`, a total count, and `id` as the last sort key.
- **Why:** agents often remember only part of a name or email, so a "contains" search fits how they work. Page numbers and a total are simple to use and to explain.
- **Alternatives:** prefix-only search (which can use an index), or SQLite FTS5. For the list, keyset (cursor) pagination.
- **Why I didn't pick them:** prefix search misses "khalil" in "Ali Khalil", and FTS5 adds setup and different matching rules. Keyset cannot show "page X of Y". At 50,000 rows the measured worst case was about 20–30 ms (search with no matches), and the last page under 2 ms.
- **Limits:** search is a full scan that grows with the table, and new orders can shift rows between pages.

## 2. Money as integer cents, total calculated on the server

- **Decision:** prices and totals are stored as integer cents (`unit_price_cents`, `total_cents`), and the server calculates the order total from the items. The client cannot send a total.
- **Why:** floating point cannot store most decimal prices exactly (`0.29 * 100` is `28.999999999999996`), so sums can drift. Integers are exact, and a total calculated by the server cannot be changed by the client.
- **Alternative:** store prices as REAL numbers and accept the total from the form.
- **Why I rejected it:** it brings rounding errors and trusts the client with money. SQLite has no built-in decimal type to fix that.
- **Details:** the form turns "24.99" into 2499 by reading the text, not by multiplying. The server only accepts whole numbers within set limits, so the total cannot overflow.

## 3. Idempotency key for creating orders (R2)

- **Decision:** each submission gets a UUID `Idempotency-Key`. In one `BEGIN IMMEDIATE` transaction the server looks up `(user, key)`; if it is new, it saves the order, its items and the key record together.
- **Duplicates:** the same key with the same body returns the first order; a different body gets 409; a deleted order gets 410. The primary key on `(user_id, idempotency_key)` blocks a second record even if two requests race.
- **Alternative:** detect duplicates by content (same customer and items within a few minutes), or only disable the submit button.
- **Why I rejected it:** content cannot tell a retry from a real second order, any time window is a guess, and a disabled button does nothing against network retries or two tabs.
- **Limits:** it only works if the client keeps the key for retries. If the user abandons an unclear attempt and submits again with a new key, a second order is possible (the form warns about this).

## AI usage

I used Claude Code to help with implementation, tests, debugging and documentation. I used
ChatGPT for planning, preparing prompts and reviewing technical choices. The code and tests
were run and checked step by step during development.
