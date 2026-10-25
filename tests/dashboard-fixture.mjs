#!/usr/bin/env node
// Serve dashboard.html against sample pool data so the UI can be checked
// without booting a second Freebuff instance.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "dashboard.html"), "utf8");
const TOKEN = "demo";
const now = Date.now();

const status = {
  activeId: "u-main",
  pid: process.pid,
  statePath: "/home/erema/.freebuff-pool/state.json",
  session: { id: "u-main", email: "kolivanbb3000@example.com", name: "главный аккаунт" },
  accounts: [
    {
      id: "u-main",
      label: "main",
      email: "kolivanbb3000@example.com",
      name: "главный аккаунт",
      active: true,
      healthy: true,
      cooldown: null,
      switches: 2,
      lastUsedAt: now - 90_000,
      quota: {
        accessTier: "limited",
        subscription: null,
        freebucks: { balance: 25, planId: null, dailyResetAt: new Date(now + 18 * 3600_000).toISOString() },
        rateLimits: {
          "m-096e75164d": { remaining: 4, limit: 6, resetAt: new Date(now + 11 * 3600_000).toISOString() },
          "m-00032eaeec": { remaining: 1, limit: 6, resetAt: new Date(now + 11 * 3600_000).toISOString() },
          "m-7e20df6765": { remaining: null, limit: 0, resetAt: null },
        },
        capturedAt: now - 20_000,
      },
    },
    {
      id: "u-alt",
      label: "alt",
      email: "alt.account@example.com",
      name: "alt",
      active: false,
      healthy: false,
      cooldown: {
        status: "rate_limited",
        reason: "Daily limit reached",
        until: now + 11 * 3600_000,
        terminal: false,
        remainingMs: 11 * 3600_000,
      },
      switches: 1,
      lastUsedAt: now - 6 * 3600_000,
      quota: {
        accessTier: "limited",
        subscription: null,
        freebucks: { balance: 0, planId: null, dailyResetAt: new Date(now + 11 * 3600_000).toISOString() },
        rateLimits: { "m-096e75164d": { remaining: 0, limit: 6, resetAt: new Date(now + 11 * 3600_000).toISOString() } },
        capturedAt: now - 6 * 3600_000,
      },
    },
    {
      id: "u-third",
      label: "backup",
      email: "backup@example.com",
      name: "backup",
      active: false,
      healthy: false,
      cooldown: { status: "banned", reason: "suspended", until: Number.MAX_SAFE_INTEGER, terminal: true, remainingMs: null },
      switches: 0,
      lastUsedAt: null,
      quota: null,
    },
  ],
  events: [
    { at: new Date(now - 90_000).toISOString(), line: "rate_limited on alt: Daily limit reached for m-096e75164d" },
    { at: new Date(now - 89_000).toISOString(), line: "switch → main (kolivanbb3000@example.com) reason=auto:rate_limited" },
  ],
};

Bun.serve({
  hostname: "127.0.0.1",
  port: 47822,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      if (url.searchParams.get("token") !== TOKEN) return new Response("no token", { status: 401 });
      return new Response(html.replaceAll("__POOL_TOKEN__", TOKEN), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.searchParams.get("token") !== TOKEN) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify(status), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
});
console.log("fixture on http://127.0.0.1:47822/?token=demo");
