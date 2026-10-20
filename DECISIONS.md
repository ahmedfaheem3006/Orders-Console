# Decisions

> In progress: one of the three decisions is written so far. The R2 decision and one more
> will be added when that work is done.

## 1. Offset pagination with an exact total, not keyset (cursor) pagination

**Decision:** the list uses `page`/`pageSize` (max 100) with `LIMIT/OFFSET`, an exact `COUNT(*)`, and `id` as a tie-breaker in every `ORDER BY`.
**Alternative considered:** keyset pagination: the client sends the last row's `(sort value, id)` and the server returns rows after it. Its cost does not grow with depth, and new orders do not shift pages.
**Why I rejected it:** agents work with "page X of Y" and a total, and keyset gives neither without the same `COUNT`. It also needs an opaque cursor per sort field and direction, which is more code to get wrong.
The main benefit of keyset did not show up at this size: the last page (OFFSET 49,975) measured about 1.2 ms in `npm run benchmark`.
**Cost I accept:** if orders are inserted while an agent pages through "newest first", rows shift by one, so a row can repeat or be skipped across pages. Changing any filter restarts from page 1.
**When I would revisit:** OFFSET and the exact search count both grow linearly. If the table grows by orders of magnitude, I would move to keyset, or drop the exact count for searches, before reaching for anything heavier.

## AI assistance

- **Claude Code (Anthropic):** used through this project as a pair programmer. I set the scope,
  stages and decisions (for example offset pagination, substring search, and integer cents
  computed on the server). Claude Code proposed and wrote most of the code, tests and README
  text under my review. It also ran the checks, benchmarks and the headless-browser
  verification reported in the README.
- **ChatGPT:** _to be completed by me with what I actually used it for._
