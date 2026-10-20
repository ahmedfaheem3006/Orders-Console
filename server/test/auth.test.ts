import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { createApp } from "../src/app";
import { LoginRateLimiter, MAX_ATTEMPTS, WINDOW_MS } from "../src/auth/loginRateLimiter";
import { signAccessToken, TOKEN_TTL_SECONDS } from "../src/auth/tokens";
import { loadJwtSecret } from "../src/config";
import type { Db } from "../src/db/connection";
import { seedDatabase } from "../src/db/seed";
import { authHeader, createTempDatabase, insertUser, startServer, TEST_JWT_SECRET, userIdByEmail } from "./helpers";

// Builds a JWT by hand so each test can break exactly one thing.
function craftToken(header: object, payload: object, secret = TEST_JWT_SECRET, hmac: "sha256" | "sha512" = "sha256"): string {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(payload)}`;
  return `${unsigned}.${createHmac(hmac, secret).update(unsigned).digest("base64url")}`;
}
const HS256 = { alg: "HS256", typ: "JWT" };
function claims(userId: number, overrides: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub: String(userId), iss: "orders-console", aud: "orders-console-api", iat: now, exp: now + 600, ...overrides };
}

describe("authentication and authorization", () => {
  let db: Db;
  let cleanup: () => void;
  let baseUrl: string;
  let close: () => Promise<void>;
  let agentId: number;
  let adminId: number;

  before(async () => {
    ({ db, cleanup } = createTempDatabase());
    await seedDatabase(db, { orderCount: 5 });
    agentId = userIdByEmail(db, "agent@orders.test");
    adminId = userIdByEmail(db, "admin@orders.test");
    ({ baseUrl, close } = await startServer(createApp({ db, jwtSecret: TEST_JWT_SECRET })));
  });
  after(async () => {
    await close();
    cleanup();
  });

  const login = (body: unknown, url = baseUrl) =>
    fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const listWith = (headers: Record<string, string> = {}, query = "") =>
    fetch(`${baseUrl}/api/orders${query}`, { headers });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe("POST /api/login", () => {
    for (const [role, email, password] of [
      ["admin", "admin@orders.test", "Admin123!"],
      ["agent", "agent@orders.test", "Agent123!"],
    ]) {
      it(`logs in the seeded ${role} and returns a working 1-hour token`, async () => {
        const res = await login({ email, password });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { token: string; expiresAt: string; user: object };
        assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "token", "user"]);
        assert.deepEqual(body.user, { id: userIdByEmail(db, email!), email, role });
        const ttl = (Date.parse(body.expiresAt) - Date.now()) / 1000;
        assert.ok(ttl > TOKEN_TTL_SECONDS - 60 && ttl <= TOKEN_TTL_SECONDS, `ttl ${ttl}`);
        assert.equal((await listWith(bearer(body.token))).status, 200);
      });
    }

    it("matches the email case-insensitively and ignores surrounding spaces", async () => {
      assert.equal((await login({ email: "  AGENT@Orders.TEST ", password: "Agent123!" })).status, 200);
    });

    it("gives the same generic 401 for a wrong password and an unknown user", async () => {
      const wrongPassword = await login({ email: "agent@orders.test", password: "agent123!" });
      const unknownUser = await login({ email: "nobody@orders.test", password: "Agent123!" });
      assert.equal(wrongPassword.status, 401);
      assert.equal(unknownUser.status, 401);
      const expected = { error: "Invalid email or password" };
      assert.deepEqual(await wrongPassword.json(), expected);
      assert.deepEqual(await unknownUser.json(), expected);
    });

    it("rejects malformed login requests with 400", async () => {
      const cases: [string, unknown][] = [
        ["array body", [{ email: "agent@orders.test", password: "x" }]],
        ["missing password", { email: "agent@orders.test" }],
        ["missing email", { password: "Agent123!" }],
        ["empty strings", { email: "", password: "" }],
        ["non-string password", { email: "agent@orders.test", password: 123456 }],
        ["invalid email", { email: "agent", password: "Agent123!" }],
        ["too-long password", { email: "agent@orders.test", password: "x".repeat(201) }],
        // A client cannot ask for a role: unknown fields are refused, not ignored.
        ["role field", { email: "agent@orders.test", password: "Agent123!", role: "admin" }],
      ];
      for (const [name, body] of cases) {
        const res = await login(body);
        assert.equal(res.status, 400, name);
        assert.equal(((await res.json()) as { error: string }).error, "Invalid login request", name);
      }
      assert.equal((await login("{ not json")).status, 400);
    });

    it("never logs passwords or tokens", async () => {
      const logged: string[] = [];
      const spies = (["log", "error", "warn", "info"] as const).map((level) =>
        mock.method(console, level, (...args: unknown[]) => logged.push(args.map(String).join(" "))),
      );
      try {
        const res = await login({ email: "agent@orders.test", password: "Agent123!" });
        const { token } = (await res.json()) as { token: string };
        await login({ email: "agent@orders.test", password: "Wrong-Password-1" });
        await listWith(bearer(token));
        await listWith(bearer(`${token}tampered`));
        const all = logged.join("\n");
        assert.ok(!all.includes("Agent123!") && !all.includes("Wrong-Password-1") && !all.includes(token));
      } finally {
        for (const spy of spies) spy.mock.restore();
      }
    });
  });

  describe("login rate limiting", () => {
    it(`blocks a (client, email) pair after ${MAX_ATTEMPTS} failed attempts, even with the right password`, async () => {
      const { baseUrl: url, close: closeApp } = await startServer(
        createApp({ db, jwtSecret: TEST_JWT_SECRET, loginRateLimiter: new LoginRateLimiter() }),
      );
      try {
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          assert.equal((await login({ email: "agent@orders.test", password: `guess-${i}` }, url)).status, 401);
        }
        const blocked = await login({ email: "agent@orders.test", password: "Agent123!" }, url);
        assert.equal(blocked.status, 429);
        assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
        // Another account from the same client is not affected.
        assert.equal((await login({ email: "admin@orders.test", password: "Admin123!" }, url)).status, 200);
      } finally {
        await closeApp();
      }
    });

    it("counts parallel guesses before the slow password check, so they cannot slip past the limit", async () => {
      const { baseUrl: url, close: closeApp } = await startServer(
        createApp({ db, jwtSecret: TEST_JWT_SECRET, loginRateLimiter: new LoginRateLimiter() }),
      );
      try {
        const statuses = await Promise.all(
          Array.from({ length: 12 }, (_, i) => login({ email: "agent@orders.test", password: `guess-${i}` }, url).then((r) => r.status)),
        );
        assert.equal(statuses.filter((s) => s === 401).length, MAX_ATTEMPTS);
        assert.equal(statuses.filter((s) => s === 429).length, 12 - MAX_ATTEMPTS);
      } finally {
        await closeApp();
      }
    });

    it("opens again after the window, and a success resets the count", () => {
      let now = 1_000_000;
      const limiter = new LoginRateLimiter(() => now);
      for (let i = 0; i < MAX_ATTEMPTS; i++) limiter.recordAttempt("1.2.3.4", "a@b.co");
      assert.ok(limiter.retryAfterSeconds("1.2.3.4", "A@B.CO") > 0, "email is case-insensitive");
      now += WINDOW_MS;
      assert.equal(limiter.retryAfterSeconds("1.2.3.4", "a@b.co"), 0);

      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) limiter.recordAttempt("1.2.3.4", "a@b.co");
      limiter.recordSuccess("1.2.3.4", "a@b.co");
      limiter.recordAttempt("1.2.3.4", "a@b.co");
      assert.equal(limiter.retryAfterSeconds("1.2.3.4", "a@b.co"), 0);
    });
  });

  describe("requireAuth on /api/orders", () => {
    it("accepts a correctly built token (baseline for the cases below)", async () => {
      assert.equal((await listWith(bearer(craftToken(HS256, claims(agentId))))).status, 200);
      assert.equal((await listWith({ Authorization: `bearer ${signAccessToken(agentId, TEST_JWT_SECRET).token}` })).status, 200);
    });

    it("rejects a missing Authorization header with 401 and WWW-Authenticate", async () => {
      const res = await listWith();
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("WWW-Authenticate"), "Bearer");
      assert.deepEqual(await res.json(), { error: "Authentication required" });
    });

    it("rejects malformed Bearer headers", async () => {
      const token = signAccessToken(agentId, TEST_JWT_SECRET).token;
      const headers = [
        token, // no scheme
        `Bearer`,
        `Bearer `,
        `Bearer  ${token}`, // two spaces
        `Bearer ${token} extra`,
        `Basic ${Buffer.from("agent@orders.test:Agent123!").toString("base64")}`,
        `Token ${token}`,
        `Bearer ${token.split(".").slice(0, 2).join(".")}`, // two parts
        `Bearer ${token}.extra`, // four parts
      ];
      for (const value of headers) {
        assert.equal((await listWith({ Authorization: value })).status, 401, value.slice(0, 30));
      }
    });

    it("ignores tokens passed in the query string", async () => {
      const token = signAccessToken(agentId, TEST_JWT_SECRET).token;
      for (const name of ["token", "access_token"]) {
        assert.equal((await listWith({}, `?${name}=${token}`)).status, 401, name);
      }
    });

    it("rejects forged, unsigned, tampered and wrong-algorithm tokens", async () => {
      const valid = signAccessToken(agentId, TEST_JWT_SECRET).token;
      const [header, payload] = valid.split(".");
      const tamperedPayload = Buffer.from(JSON.stringify({ ...claims(adminId) })).toString("base64url");
      const unsignedHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const unsignedPayload = Buffer.from(JSON.stringify(claims(adminId))).toString("base64url");

      const cases: [string, string][] = [
        ["signed with another secret", craftToken(HS256, claims(agentId), "some-other-secret-that-is-long-enough-1234")],
        ["the leaked hard-coded secret", craftToken(HS256, claims(agentId), "sarh-secret-2026")],
        ["alg none with a dummy signature", `${unsignedHeader}.${unsignedPayload}.x`],
        ["payload swapped, signature kept", `${header}.${tamperedPayload}.${valid.split(".")[2]}`],
        ["signature altered", `${header}.${payload}.${valid.split(".")[2]!.slice(0, -2)}AA`],
        ["HS512 with the right secret", craftToken({ alg: "HS512", typ: "JWT" }, claims(agentId), TEST_JWT_SECRET, "sha512")],
        ["HS256 body, header claims HS512", craftToken({ alg: "HS512", typ: "JWT" }, claims(agentId))],
      ];
      for (const [name, token] of cases) {
        assert.equal((await listWith(bearer(token))).status, 401, name);
      }
      // A token with an empty signature does not even match the Bearer format.
      assert.equal((await listWith(bearer(`${unsignedHeader}.${unsignedPayload}.`))).status, 401);
    });

    it("rejects expired tokens and tokens with invalid claims", async () => {
      const now = Math.floor(Date.now() / 1000);
      const cases: [string, string][] = [
        ["expired (signed by the app 2 hours ago)", signAccessToken(agentId, TEST_JWT_SECRET, new Date(Date.now() - 2 * 3600_000)).token],
        ["expired 1 second ago", craftToken(HS256, claims(agentId, { exp: now - 1 }))],
        ["no exp at all", craftToken(HS256, (({ exp: _exp, ...rest }) => rest)(claims(agentId)))],
        ["wrong issuer", craftToken(HS256, claims(agentId, { iss: "someone-else" }))],
        ["wrong audience", craftToken(HS256, claims(agentId, { aud: "another-api" }))],
        ["missing sub", craftToken(HS256, claims(agentId, { sub: undefined }))],
        ["numeric sub", craftToken(HS256, claims(agentId, { sub: agentId }))],
        ["non-numeric sub", craftToken(HS256, claims(agentId, { sub: "admin" }))],
        ["sub zero", craftToken(HS256, claims(agentId, { sub: "0" }))],
        ["not yet valid (nbf in the future)", craftToken(HS256, claims(agentId, { nbf: now + 600 }))],
      ];
      for (const [name, token] of cases) {
        assert.equal((await listWith(bearer(token))).status, 401, name);
      }
    });

    it("rejects a valid token whose user no longer exists", async () => {
      const userId = insertUser(db, `temp-${randomUUID()}@orders.test`, "admin");
      const headers = authHeader(userId);
      assert.equal((await listWith(headers)).status, 200);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      assert.equal((await listWith(headers)).status, 401);
      assert.equal((await listWith(authHeader(999_999))).status, 401, "never existed");
    });
  });

  describe("authorization: DELETE /api/orders/:id (admin only)", () => {
    const remove = (id: string | number, headers: Record<string, string>) =>
      fetch(`${baseUrl}/api/orders/${id}`, { method: "DELETE", headers });
    const orderExists = (id: number) => db.prepare("SELECT COUNT(*) FROM orders WHERE id = ?").pluck().get(id) === 1;
    const anyOrderId = () => db.prepare("SELECT MAX(id) FROM orders").pluck().get() as number;

    it("requires authentication", async () => {
      assert.equal((await remove(anyOrderId(), {})).status, 401);
    });

    it("refuses an agent with 403 and keeps the order", async () => {
      const id = anyOrderId();
      const res = await remove(id, authHeader(agentId));
      assert.equal(res.status, 403);
      assert.ok(orderExists(id));
    });

    it("takes the role from the database, not from the token", async () => {
      const id = anyOrderId();
      const agentClaimingAdmin = craftToken(HS256, claims(agentId, { role: "admin" }));
      assert.equal((await remove(id, bearer(agentClaimingAdmin))).status, 403);

      // Promote a user in the database: the same token now carries admin rights.
      const userId = insertUser(db, `promoted-${randomUUID()}@orders.test`, "agent");
      const token = authHeader(userId);
      assert.equal((await remove(id, token)).status, 403);
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
      assert.equal((await remove(id, token)).status, 204);
    });

    it("lets an admin delete an order with its items, then returns 404 for it", async () => {
      const id = anyOrderId();
      const res = await remove(id, authHeader(adminId));
      assert.equal(res.status, 204);
      assert.ok(!orderExists(id));
      assert.equal(db.prepare("SELECT COUNT(*) FROM order_items WHERE order_id = ?").pluck().get(id), 0);
      assert.equal((await remove(id, authHeader(adminId))).status, 404);
    });

    it("rejects invalid ids with 400", async () => {
      for (const id of ["abc", "0", "-1", "1.5", "1e3", "99999999999999999999", "1;DROP TABLE orders"]) {
        assert.equal((await remove(encodeURIComponent(id), authHeader(adminId))).status, 400, id);
      }
    });

    it("keeps the idempotency record, so a late retry of the deleted order gets 410", async () => {
      const key = randomUUID();
      const body = JSON.stringify({ customerName: "Late Retry", customerEmail: "late@example.com", items: [{ productName: "Lamp", quantity: 1, unitPriceCents: 1000 }] });
      const post = () =>
        fetch(`${baseUrl}/api/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...authHeader(agentId) },
          body,
        });
      const created = (await (await post()).json()) as { order: { id: number } };
      assert.equal((await remove(created.order.id, authHeader(adminId))).status, 204);
      const before = db.prepare("SELECT COUNT(*) FROM orders").pluck().get();
      assert.equal((await post()).status, 410);
      assert.equal(db.prepare("SELECT COUNT(*) FROM orders").pluck().get(), before, "not recreated");
    });
  });
});

describe("JWT_SECRET startup check", () => {
  it("accepts a long secret and rejects missing, short or known-public ones", () => {
    const original = process.env.JWT_SECRET;
    try {
      for (const bad of [undefined, "", "short", "sarh-secret-2026", "replace-with-a-long-random-string", "x".repeat(31)]) {
        if (bad === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = bad;
        assert.throws(() => loadJwtSecret(), /JWT_SECRET/, String(bad));
      }
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      assert.equal(loadJwtSecret(), TEST_JWT_SECRET);
    } finally {
      if (original === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = original;
    }
  });

  it("makes the real server exit with a clear message when JWT_SECRET is missing", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, JWT_SECRET: "", PORT: "39999" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    // If the check were broken the server would start and keep running: kill it, fail below.
    const killTimer = setTimeout(() => child.kill(), 15_000);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(killTimer);
    assert.equal(code, 1);
    assert.match(output, /JWT_SECRET is not set/);
    assert.doesNotMatch(output, /API listening/);
  });
});
