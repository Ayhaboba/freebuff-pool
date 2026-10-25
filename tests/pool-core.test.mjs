import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PoolCore } from "../pool-core.mjs";

const NOW = 1_800_000_000_000;
const dir = mkdtempSync(join(tmpdir(), "freebuff-pool-"));
let n = 0;
const freshFile = () => join(dir, `pool-${++n}.json`);

function makePool(file = freshFile(), clock = { t: NOW }) {
  return {
    clock,
    pool: new PoolCore({ file, now: () => clock.t, throttleSave: false }),
  };
}

const auth = (id, token = `tok-${id}`, email = `${id}@example.com`) => ({
  token,
  user: { id, email, name: id.toUpperCase() },
});

test("adds accounts, activates the newest, and persists with 0600", () => {
  const file = freshFile();
  const { pool } = makePool(file);
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));

  assert.equal(pool.state.accounts.length, 2);
  assert.equal(pool.activeAccount().id, "b");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const reread = new PoolCore({ file });
  assert.deepEqual(
    reread.state.accounts.map((a) => a.id),
    ["a", "b"],
  );
  assert.equal(reread.activeAccount().auth.token, "tok-b");
});

test("re-sign-in updates token in place instead of duplicating", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a", "old"));
  pool.upsertAuth(auth("a", "new"), { activate: false });
  assert.equal(pool.state.accounts.length, 1);
  assert.equal(pool.authFor("a").token, "new");
});

test("cooldown hides an account until its reset time", () => {
  const { pool, clock } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));
  pool.markCooldown("b", {
    status: "rate_limited",
    resetAt: new Date(NOW + 60_000).toISOString(),
  });

  const before = pool.status().accounts.find((x) => x.id === "b");
  assert.equal(before.healthy, false);
  assert.equal(pool.chooseNext({ exclude: [] }).id, "a");

  clock.t = NOW + 61_000;
  const after = pool.status().accounts.find((x) => x.id === "b");
  assert.equal(after.healthy, true, "cooldown expires at its reset time");
  assert.equal(pool.isCoolingDown(pool.account("b")), false);
  assert.equal(pool.chooseNext({ model: null, exclude: ["a"] }).id, "b");
});

test("quota score prefers remaining model quota, then balance, then freshness", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));
  pool.recordSnapshot("a", {
    accessTier: "limited",
    rateLimitsByModel: { "m-1": { remaining: 1, limit: 10 } },
    freebucks: { balance: 0 },
  });
  pool.recordSnapshot("b", {
    accessTier: "limited",
    rateLimitsByModel: { "m-1": { remaining: 7, limit: 10 } },
    freebucks: { balance: 0 },
  });
  assert.equal(pool.chooseNext({ model: "m-1" }).id, "b");

  // Unknown quota outranks an obviously drained one.
  pool.upsertAuth(auth("c"));
  pool.recordSnapshot("b", {
    rateLimitsByModel: { "m-1": { remaining: 0, limit: 10 } },
    freebucks: { balance: 0 },
  });
  assert.equal(pool.chooseNext({ model: "m-1", exclude: ["a"] }).id, "c");
});

test("failoverFor maps quota errors to resetAt cooldowns and ignores model errors", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  const quota = Object.assign(new Error("Daily limit reached"), {
    name: "FreebuffSessionError",
    status: "rate_limited",
    detail: { resetAt: new Date(NOW + 4 * 3600_000).toISOString() },
  });
  const decision = pool.failoverFor(quota);
  assert.equal(decision.accountId, "a");
  assert.equal(decision.action, "cooldown");
  assert.equal(decision.retry, true);

  pool.markCooldown(decision.accountId, decision.cooldown);
  assert.equal(pool.account("a").cooldown.until, NOW + 4 * 3600_000);

  const modelGone = Object.assign(new Error("nope"), {
    status: "model_unavailable",
    detail: {},
  });
  assert.equal(pool.failoverFor(modelGone), null);
});

test("banned accounts are parked permanently and never chosen", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));
  const banned = Object.assign(new Error("banned"), { status: "banned", detail: {} });
  const decision = pool.failoverFor(banned);
  pool.markCooldown(decision.accountId, decision.cooldown);
  assert.equal(pool.chooseNext().id, "a");
  assert.equal(pool.account("b").cooldown.terminal, true);
});

test("removing the active account promotes another one", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));
  pool.remove("b");
  assert.equal(pool.activeAccount().id, "a");
  assert.equal(pool.state.accounts.length, 1);
});

test("each account gets a stable install id of its own", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));
  const first = pool.ensureIdentity("a").installId;
  const second = pool.ensureIdentity("a").installId;
  const other = pool.ensureIdentity("b").installId;
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("proxy and timezone are validated and stored per account", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));

  pool.setProxy("a", "http://127.0.0.1:1080");
  pool.setProxy("b", "socks5://10.0.0.5:1080");
  assert.equal(pool.account("a").identity.proxy, "http://127.0.0.1:1080");
  assert.equal(pool.account("b").identity.proxy, "socks5://10.0.0.5:1080");
  assert.throws(() => pool.setProxy("a", "not a proxy"), /proxy must look like/);

  pool.setProxy("a", "none");
  assert.equal(pool.account("a").identity.proxy, null);

  pool.setTimezone("a", "Europe/Berlin");
  assert.equal(pool.account("a").identity.timezone, "Europe/Berlin");
  assert.throws(() => pool.setTimezone("a", "berlin; rm -rf"), /timezone must look like/);

  const status = pool.status().accounts.find((x) => x.id === "a");
  assert.equal(status.identity.timezone, "Europe/Berlin");
});

test("status masks credentials inside a proxy URL", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.setProxy("a", "http://user:secret@127.0.0.1:8080");
  assert.equal(pool.status().accounts[0].identity.proxy, "http://127.0.0.1:8080");
});

test("status never leaks tokens", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  const text = JSON.stringify(pool.status());
  assert.equal(text.includes("tok-a"), false);
  assert.equal(readFileSync(pool.file, "utf8").includes("tok-a"), true);
});
