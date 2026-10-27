// pool-core.mjs — account pool for Freebuff Desktop.
// Pure state: no network, no Electron. The orchestrator runtime wires this to
// AuthStore/SessionManager; tests drive it directly.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const FILE_MODE = 0o600;
const SAVE_THROTTLE_MS = 5000;

// Admission failures that are worth a different account.
const QUOTA_STATUSES = new Set(["rate_limited", "spend_limited"]);
// Concurrency refusals: this account's hour/tab is in use somewhere else.
// The client answers them in place — the "Use it here" takeover moves the
// hour into the current tab — so they only fail over when asked to.
const BUSY_STATUSES = new Set([
  "session_limit_reached",
  "purchase_capacity",
  "premium_slot_taken",
  "purchase_in_use",
]);
const DEAD_STATUSES = new Set([
  "banned",
  "unauthenticated",
  "account_changed",
  "country_blocked",
]);

const PROXY_PATTERN = /^(https?|socks5h?):\/\/[^\s/]+\/?$/i;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;

function toMs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // seconds vs ms
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStatus(error) {
  if (!error || typeof error !== "object") return null;
  const status = typeof error.status === "string" ? error.status : null;
  if (!status) return null;
  const detail = error.detail && typeof error.detail === "object" ? error.detail : {};
  return {
    status,
    message: typeof error.message === "string" ? error.message : "",
    detail,
  };
}

export function maskProxy(proxy) {
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid";
  }
}

export class PoolCore {
  constructor({ file, now = () => Date.now(), throttleSave = true } = {}) {
    if (!file) throw new Error("PoolCore needs a file path");
    this.file = file;
    this.now = now;
    this.throttleSave = throttleSave;
    this.lastSaveAt = 0;
    this.state = { version: 1, activeId: null, accounts: [], updatedAt: null };
    this.load();
  }

  // ── persistence ────────────────────────────────────────────────────────
  load() {
    try {
      if (!existsSync(this.file)) return this.state;
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
      this.state = {
        version: 1,
        activeId: typeof raw?.activeId === "string" ? raw.activeId : null,
        accounts: accounts.filter(
          (a) =>
            a &&
            typeof a.id === "string" &&
            a.auth &&
            typeof a.auth.token === "string" &&
            a.auth.user &&
            typeof a.auth.user.id === "string",
        ),
        updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : null,
      };
      if (this.state.activeId && !this.account(this.state.activeId)) {
        this.state.activeId = this.state.accounts[0]?.id ?? null;
      }
    } catch (error) {
      console.warn(`[pool] could not read ${this.file}: ${error?.message ?? error}`);
    }
    return this.state;
  }

  save({ force = false } = {}) {
    const now = this.now();
    if (!force && this.throttleSave && now - this.lastSaveAt < SAVE_THROTTLE_MS) return;
    this.lastSaveAt = now;
    this.state.updatedAt = now;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, {
        mode: FILE_MODE,
        flag: "wx",
      });
      chmodSync(tmp, FILE_MODE);
      renameSync(tmp, this.file);
    } catch (error) {
      console.warn(`[pool] could not write ${this.file}: ${error?.message ?? error}`);
    }
  }

  // ── accounts ───────────────────────────────────────────────────────────
  account(id) {
    return this.state.accounts.find((a) => a.id === id) ?? null;
  }

  activeAccount() {
    return this.state.activeId ? this.account(this.state.activeId) : null;
  }

  /**
   * Record a sign-in (or a re-sign-in of a known account) and make it active.
   * Idempotent by user id; a rotated token replaces the old one in place.
   */
  upsertAuth(auth, { activate = true, label = null } = {}) {
    const token = typeof auth?.token === "string" ? auth.token.trim() : "";
    const user = auth?.user ?? {};
    const id = typeof user.id === "string" ? user.id.trim() : "";
    if (!token || !id) throw new Error("upsertAuth needs auth.token and auth.user.id");

    const now = this.now();
    let account = this.account(id);
    if (!account) {
      account = {
        id,
        label: label?.trim() || user.email || user.name || `account-${this.state.accounts.length + 1}`,
        auth: { token, user: { id, email: user.email, name: user.name } },
        addedAt: now,
        lastUsedAt: null,
        switches: 0,
        quota: null,
        cooldown: null,
        lastError: null,
        identity: { installId: null, proxy: null, timezone: null },
      };
      this.state.accounts.push(account);
    } else {
      account.auth = { token, user: { ...account.auth.user, ...user, id } };
      if (label?.trim()) account.label = label.trim();
    }
    account.identity ??= { installId: null, proxy: null, timezone: null };
    if (activate) this.activateInternal(account, { countSwitch: false });
    this.save({ force: true });
    return account;
  }

  activateInternal(account, { countSwitch = true } = {}) {
    const previous = this.state.activeId;
    this.state.activeId = account.id;
    account.lastUsedAt = this.now();
    account.cooldown = null;
    if (countSwitch && previous && previous !== account.id) account.switches += 1;
  }

  /** Make an account active without touching tokens (runtime does the swap). */
  setActive(id, { force = false } = {}) {
    const account = this.account(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    if (!force && this.isCoolingDown(account)) {
      throw new Error(`account ${id} is in cooldown until ${new Date(account.cooldown.until).toISOString()}`);
    }
    this.activateInternal(account);
    this.save({ force: true });
    return account;
  }

  remove(id) {
    const index = this.state.accounts.findIndex((a) => a.id === id);
    if (index === -1) throw new Error(`unknown account: ${id}`);
    const [removed] = this.state.accounts.splice(index, 1);
    if (this.state.activeId === id) {
      const next = this.chooseNext({ exclude: [id] }) ?? this.state.accounts[0] ?? null;
      this.state.activeId = next?.id ?? null;
      if (next) next.lastUsedAt = this.now();
    }
    this.save({ force: true });
    return removed;
  }

  ensureIdentity(id) {
    const account = this.account(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    let changed = false;
    account.identity ??= { installId: null, proxy: null, timezone: null };
    if (!account.identity.installId) {
      account.identity.installId = randomUUID();
      changed = true;
    }
    if (changed) this.save({ force: true });
    return account.identity;
  }

  setProxy(id, proxy) {
    const account = this.account(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const clean = String(proxy ?? "").trim();
    if (clean && clean !== "none" && !PROXY_PATTERN.test(clean)) {
      throw new Error("proxy must look like http://host:port, socks5://host:port or none");
    }
    account.identity ??= { installId: null, proxy: null, timezone: null };
    account.identity.proxy = clean && clean !== "none" ? clean : null;
    this.save({ force: true });
    return account.identity;
  }

  setTimezone(id, timezone) {
    const account = this.account(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const clean = String(timezone ?? "").trim();
    if (clean && clean !== "none" && !TIMEZONE_PATTERN.test(clean)) {
      throw new Error("timezone must look like Europe/Berlin (+01:00 is accepted too), or none");
    }
    account.identity ??= { installId: null, proxy: null, timezone: null };
    account.identity.timezone = clean && clean !== "none" ? clean : null;
    this.save({ force: true });
    return account.identity;
  }

  rename(id, label) {
    const account = this.account(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    const clean = String(label ?? "").trim().slice(0, 64);
    if (!clean) throw new Error("label is empty");
    account.label = clean;
    this.save({ force: true });
    return account;
  }

  // ── health / quota ─────────────────────────────────────────────────────
  isCoolingDown(account, at = this.now()) {
    const until = account?.cooldown?.until;
    return typeof until === "number" && until > at;
  }

  markCooldown(id, { status, reason = null, resetAt = null, retryAfterMs = null, defaultMs = 120000 } = {}) {
    const account = this.account(id);
    if (!account) return null;
    const now = this.now();
    let until = toMs(resetAt);
    if (!until && Number.isFinite(retryAfterMs)) until = now + Math.max(0, retryAfterMs);
    if (!until) until = now + defaultMs;
    const terminal = DEAD_STATUSES.has(status);
    account.cooldown = {
      status: status ?? "unknown",
      reason: reason ?? null,
      until: terminal ? Number.MAX_SAFE_INTEGER : until,
      since: now,
      terminal,
    };
    account.lastError = { status: status ?? null, reason, at: now };
    this.save({ force: true });
    return account.cooldown;
  }

  clearCooldown(id) {
    const account = this.account(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    account.cooldown = null;
    this.save({ force: true });
    return account;
  }

  /**
   * Remember a refusal without benching the account.
   * Used when the refusal is real but another account should not answer for it.
   */
  noteError(id, { status = null, reason = null } = {}) {
    const account = this.account(id);
    if (!account) return null;
    account.lastError = { status, reason, at: this.now() };
    this.save({ force: true });
    return account.lastError;
  }

  /**
   * Does this `sessions.snapshot()` describe live paid time on this account?
   *
   * A live hour is the one thing a switch cannot give back: `applyAccount`
   * releases the account's sessions before swapping identity, and the hour's
   * clock keeps running while the pool is parked on another account. So a
   * refusal is not failover material while one is up.
   */
  hasLiveHour(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    // snapshot() already filters expired sessions out of this map.
    if (Object.keys(snapshot.activeSessionsByThread ?? {}).length > 0) return true;
    const now = this.now();
    return (snapshot.desktopPurchases ?? []).some((purchase) => {
      if (!purchase?.holderInstanceId) return false; // bought but not held by a tab
      const expiresAt = Date.parse(purchase.expiresAt ?? "");
      return !Number.isFinite(expiresAt) || expiresAt > now;
    });
  }

  /** Keep a compact copy of what the server last said about this account. */
  recordSnapshot(id, snapshot, { force = false } = {}) {
    const account = this.account(id);
    if (!account || !snapshot || typeof snapshot !== "object") return;
    const freebucks = snapshot.freebucks;
    const rateLimits = snapshot.rateLimitsByModel;
    const quota = {
      accessTier: snapshot.accessTier ?? null,
      subscription: snapshot.subscription?.tierId ?? null,
      freebucks:
        freebucks && typeof freebucks === "object"
          ? {
              balance: Number.isFinite(freebucks.balance) ? freebucks.balance : null,
              planId: freebucks.planId ?? null,
              dailyResetAt: freebucks.daily?.resetAt ?? null,
              claimable: Number.isFinite(freebucks.claimableGrantFreebucks)
                ? freebucks.claimableGrantFreebucks
                : null,
            }
          : null,
      rateLimits:
        rateLimits && typeof rateLimits === "object"
          ? Object.fromEntries(
              Object.entries(rateLimits).map(([model, q]) => [
                model,
                {
                  remaining: Number.isFinite(q?.remaining) ? q.remaining : null,
                  limit: Number.isFinite(q?.limit) ? q.limit : null,
                  resetAt: q?.resetAt ?? null,
                },
              ]),
            )
          : null,
      capturedAt: this.now(),
    };
    // A fresh snapshot after the cooldown expired means the account is usable.
    if (account.cooldown && !this.isCoolingDown(account)) account.cooldown = null;
    account.quota = quota;
    this.save({ force });
  }

  quotaScore(account, model) {
    if (this.isCoolingDown(account)) return Number.NEGATIVE_INFINITY;
    const quota = account.quota;
    if (!quota) return 500; // unknown: usable, but behind a known-good account
    let score = 0;
    let known = false;
    const limit = model ? quota.rateLimits?.[model] : null;
    if (limit) {
      known = true;
      // A known drain is worse than an unknown account: only credit real headroom.
      if (Number.isFinite(limit.remaining) && limit.remaining > 0) {
        score += 1e6 + limit.remaining * 1e3;
      } else if (!Number.isFinite(limit.remaining) && Number.isFinite(limit.limit)) {
        score += 1e6;
      }
    }
    const balance = quota.freebucks?.balance;
    if (Number.isFinite(balance)) {
      known = true;
      if (balance > 0) score += 1e3 + balance;
    }
    if (!known) score = 500;
    const ageHours = Math.min(24, Math.max(0, (this.now() - quota.capturedAt) / 3.6e6));
    return score - ageHours; // fresher data wins close calls
  }

  /** Pick the healthiest account, excluding ids (and optionally the active one). */
  chooseNext({ model = null, exclude = [] } = {}) {
    const excluded = new Set(exclude);
    const candidates = this.state.accounts.filter(
      (a) => !excluded.has(a.id) && !this.isCoolingDown(a),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const delta = this.quotaScore(b, model) - this.quotaScore(a, model);
      if (delta !== 0) return delta;
      return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
    });
    return candidates[0];
  }

  /**
   * Translate an admission error into a failover decision.
   *
   * Returns null when switching accounts cannot help. Two refusals explicitly
   * do not switch by default:
   *
   *   - concurrency refusals (`busy`): the tab resolves them itself — "Use it
   *     here" takes the held hour over, without a charge. Switching answered
   *     them by releasing that hour and spending the next account instead;
   *   - quota refusals while this account still holds a live hour: switching
   *     would release the hour to buy the same time on the next account.
   *
   * Both are recorded on the account (`action: "note"` / `"hold"`, `retry:
   * false`, no cooldown — the account is still healthy) so the refusal is
   * visible without benching it. `allowBusy` and `protectLiveHour: false`
   * restore the fail-fast behaviour of the first release.
   */
  failoverFor(error, { allowBusy = false, protectLiveHour = true, hasLiveHour = false } = {}) {
    const parsed = parseStatus(error);
    if (!parsed) return null;
    const { status, message, detail } = parsed;
    const active = this.activeAccount();
    if (!active) return null;

    if (DEAD_STATUSES.has(status)) {
      return {
        accountId: active.id,
        status,
        reason: message,
        action: "disable",
        cooldown: { status, reason: message, defaultMs: 0 },
        retry: false,
      };
    }
    if (BUSY_STATUSES.has(status)) {
      if (!allowBusy) {
        return {
          accountId: active.id,
          status,
          reason: message,
          action: "note",
          cooldown: null,
          retry: false,
        };
      }
      return {
        accountId: active.id,
        status,
        reason: message,
        action: "cooldown",
        cooldown: { status, reason: message, defaultMs: 90 * 1000 },
        retry: true,
      };
    }
    if (QUOTA_STATUSES.has(status)) {
      if (protectLiveHour && hasLiveHour) {
        return {
          accountId: active.id,
          status,
          reason: message,
          action: "hold",
          cooldown: null,
          retry: false,
        };
      }
      return {
        accountId: active.id,
        status,
        reason: message,
        action: "cooldown",
        cooldown: {
          status,
          reason: message,
          resetAt: detail.resetAt ?? null,
          retryAfterMs: detail.retryAfterMs ?? null,
          defaultMs: 15 * 60 * 1000,
        },
        retry: true,
      };
    }
    return null;
  }

  // ── reporting ──────────────────────────────────────────────────────────
  status({ now = this.now() } = {}) {
    return {
      activeId: this.state.activeId,
      updatedAt: this.state.updatedAt,
      accounts: this.state.accounts.map((a) => {
        const until = a.cooldown?.until ?? null;
        const cooling = this.isCoolingDown(a, now);
        return {
          id: a.id,
          label: a.label,
          email: a.auth.user.email ?? null,
          name: a.auth.user.name ?? null,
          addedAt: a.addedAt ?? null,
          lastUsedAt: a.lastUsedAt ?? null,
          switches: a.switches ?? 0,
          active: a.id === this.state.activeId,
          healthy: !cooling,
          cooldown: cooling
            ? {
                status: a.cooldown.status,
                reason: a.cooldown.reason ?? null,
                until,
                terminal: a.cooldown.terminal === true,
                remainingMs: until === Number.MAX_SAFE_INTEGER ? null : Math.max(0, until - now),
              }
            : null,
          quota: a.quota,
          identity: {
            installId: a.identity?.installId ?? null,
            timezone: a.identity?.timezone ?? null,
            proxy: a.identity?.proxy ? maskProxy(a.identity.proxy) : null,
          },
          lastError: a.lastError ?? null,
        };
      }),
    };
  }

  /** Full auth record for the runtime; never exposed over HTTP. */
  authFor(id) {
    return this.account(id)?.auth ?? null;
  }
}
