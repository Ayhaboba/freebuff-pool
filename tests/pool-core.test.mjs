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

test("concurrency refusals stay on the account and let the tab take the hour over", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  pool.upsertAuth(auth("b"));
  pool.setActive("a");

  const refused = Object.assign(
    new Error(
      "Your purchased hour for DeepSeek V4.1 Flash is in use in another tab \u2014 choose \u201CUse it here\u201D to move the remaining time here",
    ),
    { name: "FreebuffSessionError", status: "purchase_in_use", detail: {} },
  );
  const decision = pool.failoverFor(refused);
  assert.equal(decision.accountId, "a");
  assert.equal(decision.action, "note");
  assert.equal(decision.retry, false);
  assert.equal(decision.cooldown, null);

  // The runtime records the refusal and leaves the account usable.
  pool.noteError(decision.accountId, { status: decision.status, reason: decision.reason });
  assert.equal(pool.state.activeId, "a");
  assert.equal(pool.isCoolingDown(pool.account("a")), false);
  assert.equal(pool.status().accounts.find((x) => x.id === "a").healthy, true);
  assert.equal(pool.account("a").lastError.status, "purchase_in_use");

  // Opting in restores the old fail-fast behaviour.
  const forced = pool.failoverFor(refused, { allowBusy: true });
  assert.equal(forced.action, "cooldown");
  assert.equal(forced.retry, true);
  assert.equal(forced.cooldown.defaultMs, 90_000);
  pool.markCooldown(forced.accountId, forced.cooldown);
  assert.equal(pool.isCoolingDown(pool.account("a")), true);
});

test("a quota refusal never releases a live hour to buy time on another account", () => {
  const { pool } = makePool();
  pool.upsertAuth(auth("a"));
  const quota = Object.assign(new Error("Daily limit reached"), {
    name: "FreebuffSessionError",
    status: "rate_limited",
    detail: { resetAt: new Date(NOW + 3600_000).toISOString() },
  });

  const held = { activeSessionsByThread: { t1: { expiresAt: new Date(NOW + 3300_000).toISOString() } } };
  const decision = pool.failoverFor(quota, { hasLiveHour: pool.hasLiveHour(held) });
  assert.equal(decision.action, "hold");
  assert.equal(decision.retry, false);
  assert.equal(decision.cooldown, null);
  pool.noteError(decision.accountId, { status: decision.status, reason: decision.reason });
  assert.equal(pool.isCoolingDown(pool.account("a")), false);

  // No live hour: the same refusal still fails over.
  assert.equal(pool.failoverFor(quota, { hasLiveHour: false }).retry, true);
  // And the protection can be turned off.
  assert.equal(pool.failoverFor(quota, { hasLiveHour: true, protectLiveHour: false }).retry, true);
});

test("hasLiveHour reads live sessions and hours held by a tab", () => {
  const { pool } = makePool();
  const later = new Date(NOW + 600_000).toISOString();
  const past = new Date(NOW - 600_000).toISOString();

  assert.equal(pool.hasLiveHour({}), false);
  assert.equal(pool.hasLiveHour({ activeSessionsByThread: { t1: {} } }), true);
  assert.equal(pool.hasLiveHour({ desktopPurchases: [{ holderInstanceId: "i", expiresAt: later }] }), true);
  assert.equal(pool.hasLiveHour({ desktopPurchases: [{ holderInstanceId: "i", expiresAt: past }] }), false);
  assert.equal(
    pool.hasLiveHour({ desktopPurchases: [{ expiresAt: later }] }),
    false,
    "a purchase no tab is holding is not a running hour",
  );
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
