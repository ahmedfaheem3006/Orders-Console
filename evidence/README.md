# Evidence

Three screenshots, taken from the running app and real command output with headless Chrome.

1. `1-r1-orders-console.png`: the orders list after logging in as the agent. It shows a
   search for "ali", status "Paid", sorted by total amount (highest first), on page 2 of 15.
2. `2-r1-rapid-filter.png`: the API was started with `SIMULATED_LATENCY_MS=1500`, and the
   status filter was changed paid → pending → shipped, 40 ms apart. The two older requests
   were cancelled, and the table only shows the last choice ("shipped"). Below it is the
   output of the automated Vitest check, where the responses arrive in reverse order.
3. `3-r2-duplicate-proof.png`: the same create request sent twice in parallel with the same
   `Idempotency-Key` to the running API. Both responses point to the same order, and searching
   afterwards finds exactly one order. Below it is the output of `npm run test:r2`.

Images 2 and 3 show the real output as text on a simple page, so it is readable. No tokens
or passwords are shown.
