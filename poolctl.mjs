#!/usr/bin/env node
// Control the Freebuff pool from a shell.
//   node poolctl.mjs status
//   node poolctl.mjs switch second@example.com
//   node poolctl.mjs add
//   node poolctl.mjs import ~/.config/freebuff-desktop/state.json
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PoolCore } from "./pool-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultPoolFile = join(homedir(), ".freebuff-pool", "pool.json");
const poolFile = process.env.FREEBUFF_POOL_FILE || defaultPoolFile;
const controlFile = `${poolFile}.control.json`;
const isWindows = process.platform === "win32";
// The installed app's own profile: %APPDATA% on Windows, ~/.config on Linux.
const defaultStatePath = isWindows
  ? join(process.env.APPDATA || homedir(), "freebuff-desktop", "state.json")
  : join(homedir(), ".config", "freebuff-desktop", "state.json");
const launcherHint = isWindows ? "run-pool.ps1" : "run-pool.sh";

const [command = "status", ...rest] = process.argv.slice(2);

function control() {
  if (!existsSync(controlFile)) return null;
  try {
    return JSON.parse(readFileSync(controlFile, "utf8"));
  } catch {
    return null;
  }
}

let liveCache;
async function liveControl() {
  if (liveCache !== undefined) return liveCache;
  const ctl = control();
  if (!ctl?.url || !ctl?.token) return (liveCache = null);
  try {
    const url = new URL("/api/status", new URL(ctl.url));
    url.searchParams.set("token", ctl.token);
    const response = await fetch(url, {
      headers: { "x-pool-token": ctl.token },
      signal: AbortSignal.timeout(1500),
    });
    liveCache = response.ok ? ctl : null;
  } catch {
    liveCache = null;
  }
  return liveCache;
}

async function call(path) {
  const ctl = await liveControl();
  if (!ctl) {
    throw new Error(`pool control plane is not running \u2014 start it with ${launcherHint}`);
  }
  const url = new URL(path, new URL(ctl.url));
  url.searchParams.set("token", ctl.token);
  const response = await fetch(url, { headers: { "x-pool-token": ctl.token } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function offlineStatus() {
  const core = new PoolCore({ file: poolFile });
  return core.status();
}

function printStatus(status) {
  const rows = status.accounts.map((a) => {
    const state = a.cooldown?.terminal
      ? "parked"
      : a.cooldown
        ? `cooling ${Math.ceil((a.cooldown.remainingMs ?? 0) / 60000)}m`
        : a.active
          ? "active"
          : "idle";
    const quota = a.quota;
    const bits = [];
    if (quota?.freebucks?.balance != null) bits.push(`fb ${quota.freebucks.balance.toFixed(2)}`);
    const limitEntries = Object.entries(quota?.rateLimits ?? {});
    for (const [model, q] of limitEntries.slice(0, 2)) {
      bits.push(`${model} ${q.remaining ?? "?"}/${q.limit ?? "?"}`);
    }
    const egress = a.identity?.proxy ?? "direct";
    const tz = a.identity?.timezone ? ` tz ${a.identity.timezone}` : "";
    return [
      a.active ? "*" : " ",
      a.label.padEnd(18).slice(0, 18),
      (a.email ?? a.id).padEnd(32).slice(0, 32),
      state.padEnd(14),
      `${egress}${tz}`.padEnd(26).slice(0, 26),
      bits.join("  "),
    ];
  });
  const head = [" ", "label".padEnd(18), "account".padEnd(32), "state".padEnd(14), "egress".padEnd(26), "quota"];
  console.log([head, ...rows].map((r) => r.join(" ")).join("\n"));
  console.log(`\n${status.accounts.length} account(s) · pool ${poolFile}`);
  if (liveCache) console.log(`dashboard ${liveCache.url}`);
  else console.log(`control plane: stopped (start ~/.freebuff-pool/${launcherHint})`);
}

try {
  if (command === "status") {
    const live = (await liveControl()) ? await call("/api/status").catch(() => null) : null;
    printStatus(live ?? offlineStatus());
  } else if (command === "switch") {
    const needle = (rest[0] ?? "").trim();
    if (!needle) throw new Error("usage: poolctl switch <id|email|label>");
    const status = await call("/api/status");
    const match =
      status.accounts.find((a) => a.id === needle) ??
      status.accounts.find((a) => a.email === needle) ??
      status.accounts.find((a) => a.label.toLowerCase() === needle.toLowerCase()) ??
      status.accounts[Number(needle)];
    if (!match) throw new Error(`no account matches ${needle}`);
    await call(`/api/switch?id=${encodeURIComponent(match.id)}`);
    console.log(`active → ${match.label} (${match.email ?? match.id})`);
  } else if (command === "add") {
    const started = await call("/api/add");
    console.log("Open this URL and sign in with the account you want to pool:\n");
    console.log(started.url);
    console.log("\nThe account is added automatically when the sign-in completes.");
  } else if (command === "remove") {
    if (!rest[0]) throw new Error("usage: poolctl remove <id|email|label>");
    const status = await call("/api/status");
    const match = status.accounts.find((a) => a.id === rest[0] || a.email === rest[0] || a.label === rest[0]);
    if (!match) throw new Error(`no account matches ${rest[0]}`);
    await call(`/api/remove?id=${encodeURIComponent(match.id)}`);
    console.log(`removed ${match.label}`);
  } else if (command === "label") {
    const [needle, ...words] = rest;
    if (!needle || words.length === 0) throw new Error("usage: poolctl label <id|email> <new label>");
    const status = await call("/api/status");
    const match = status.accounts.find((a) => a.id === needle || a.email === needle);
    if (!match) throw new Error(`no account matches ${needle}`);
    await call(`/api/label?id=${encodeURIComponent(match.id)}&label=${encodeURIComponent(words.join(" "))}`);
    console.log(`renamed ${match.id} → ${words.join(" ")}`);
  } else if (command === "clear") {
    const status = await call("/api/status");
    const match = status.accounts.find((a) => a.id === rest[0] || a.email === rest[0] || a.label === rest[0]);
    if (!match) throw new Error(`no account matches ${rest[0] ?? ""}`);
    await call(`/api/clear?id=${encodeURIComponent(match.id)}`);
    console.log(`cooldown cleared for ${match.label}`);
  } else if (command === "proxy") {
    const [needle, value] = rest;
    if (!needle || value === undefined) {
      throw new Error("usage: poolctl proxy <id|email|label> <http://host:port|socks5://host:port|none>");
    }
    const status = await call("/api/status");
    const match = status.accounts.find((a) => a.id === needle || a.email === needle || a.label === needle);
    if (!match) throw new Error(`no account matches ${needle}`);
    const result = await call(`/api/proxy?id=${encodeURIComponent(match.id)}&proxy=${encodeURIComponent(value)}`);
    const now = result.status.accounts.find((a) => a.id === match.id);
    console.log(`${match.label}: proxy ${now?.identity?.proxy ?? "none"}`);
  } else if (command === "tz") {
    const [needle, value] = rest;
    if (!needle || value === undefined) {
      throw new Error("usage: poolctl tz <id|email|label> <Europe/Berlin|+01:00|none>");
    }
    const status = await call("/api/status");
    const match = status.accounts.find((a) => a.id === needle || a.email === needle || a.label === needle);
    if (!match) throw new Error(`no account matches ${needle}`);
    const result = await call(`/api/tz?id=${encodeURIComponent(match.id)}&tz=${encodeURIComponent(value)}`);
    const now = result.status.accounts.find((a) => a.id === match.id);
    console.log(`${match.label}: timezone ${now?.identity?.timezone ?? "system"}`);
  } else if (command === "import") {
    const source = resolve(rest[0] ?? defaultStatePath);
    if (!existsSync(source)) throw new Error(`no such state file: ${source}`);
    const state = JSON.parse(readFileSync(source, "utf8"));
    const sessions = state.authSessions ?? {};
    const entries = Object.entries(sessions);
    if (entries.length === 0) throw new Error(`no authSessions in ${source}`);
    const core = new PoolCore({ file: poolFile });
    for (const [host, session] of entries) {
      if (!session?.token || !session?.user?.id) continue;
      core.upsertAuth(
        { token: session.token, user: session.user },
        { activate: entries[0]?.[0] === host },
      );
      console.log(`imported ${session.user.email ?? session.user.id} (${host})`);
    }
    console.log(`pool now holds ${core.state.accounts.length} account(s): ${poolFile}`);
  } else if (command === "events") {
    const status = await call("/api/status");
    for (const event of status.events ?? []) console.log(`${event.at}  ${event.line}`);
  } else if (command === "open") {
    const ctl = await liveControl();
    if (!ctl) throw new Error(`pool control plane is not running \u2014 start it with ${launcherHint}`);
    console.log(ctl.url);
  } else {
    console.error("commands: status | switch | add | remove | label | clear | proxy | tz | import | events | open");
    process.exit(2);
  }
} catch (error) {
  console.error(`poolctl: ${error.message}`);
  process.exit(1);
}

export { here };
