/* __FREEBUFF_POOL_RUNTIME__ v1 */
// Injected into resources/orchestrator/orchestrator.js immediately before the
// Bun.serve call. Everything below runs in the orchestrator's module scope, so
// auth3 / sessions / login / registry2 / broadcastAuth are the live instances.
try {
  const __poolPath = await import("node:path");
  const __poolFs = await import("node:fs");
  const __poolUrl = await import("node:url");
  const __poolCrypto = await import("node:crypto");

  const __poolDir = __poolPath.dirname(desktopStatePath());
  const __poolFile = (
    process.env.FREEBUFF_POOL_FILE || `${desktopStatePath()}.pool.json`
  ).trim();
  const __poolCorePath = (
    process.env.FREEBUFF_POOL_CORE || __poolPath.join(__poolDir, "pool-core.mjs")
  ).trim();
  const __poolDashPath = (
    process.env.FREEBUFF_POOL_DASHBOARD || __poolPath.join(__poolDir, "dashboard.html")
  ).trim();
  const __poolLogPath = `${__poolFile}.log`;

  const { PoolCore } = await import(__poolUrl.pathToFileURL(__poolCorePath).href);
  const core = new PoolCore({ file: __poolFile });
  const identityDir = `${__poolFile}.device-keys`;
  const events = [];
  const note = (line) => {
    const entry = { at: new Date().toISOString(), line: String(line).slice(0, 500) };
    events.push(entry);
    if (events.length > 200) events.shift();
    console.warn(`[pool] ${entry.line}`);
    try {
      __poolFs.appendFileSync(__poolLogPath, `${entry.at} ${entry.line}\n`, { mode: 0o600 });
    } catch {}
  };
  note(
    `runtime up: file=${__poolFile} accounts=${core.state.accounts.length} active=${
      core.state.activeId ?? "none"
    }`,
  );

  const identityFile = (accountId) =>
    __poolPath.join(identityDir, `${String(accountId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

  async function generateDeviceKeyRecord() {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    return {
      version: 1,
      publicKey: b64url(publicKey),
      privateKey: b64url(privateKey),
      registrations: {},
    };
  }

  function readIdentityRecord(accountId) {
    try {
      const record = JSON.parse(__poolFs.readFileSync(identityFile(accountId), "utf8"));
      return record?.version === 1 && record.publicKey && record.privateKey ? record : null;
    } catch {
      return null;
    }
  }

  function writeIdentityRecord(accountId, record) {
    try {
      __poolFs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
      const target = identityFile(accountId);
      const tmp = `${target}.tmp`;
      __poolFs.rmSync(tmp, { force: true });
      __poolFs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      __poolFs.renameSync(tmp, target);
    } catch (error) {
      note(`could not store the device key for ${accountId}: ${error?.message ?? error}`);
    }
  }

  const deviceSigner = () => integrity?.deps?.signer ?? null;
  const deviceStore = () => deviceSigner()?.options?.store ?? null;

  /** Give every account its own device identity before its first request. */
  async function swapDeviceIdentity(account, previousId) {
    const signer = deviceSigner();
    const store = deviceStore();
    if (previousId && previousId !== account.id && store?.load) {
      const live = await store.load().catch(() => null);
      if (live) writeIdentityRecord(previousId, live);
    }
    let record = readIdentityRecord(account.id);
    if (!record) {
      record = await generateDeviceKeyRecord();
      writeIdentityRecord(account.id, record);
      note(`minted a device key for ${account.label}`);
    }
    if (store?.save) await store.save(record).catch(() => {});
    if (signer) {
      signer.stored = null;
      signer.loading = null;
      signer.retryAfter?.clear?.();
    }
    try {
      setDesktopInstallId(core.ensureIdentity(account.id).installId);
    } catch {}
  }

  // Per-account egress: proxy + timezone. Bun's fetch takes a per-request proxy.
  const FETCH_WRAPPED = Symbol.for("freebuff.pool.fetch");
  if (!globalThis[FETCH_WRAPPED]) {
    const originalFetch = globalThis.fetch;
    const isLoopback = (value) => {
      try {
        const url =
          typeof value === "string" || value instanceof URL
            ? new URL(String(value))
            : new URL(value.url);
        return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
      } catch {
        return true;
      }
    };
    globalThis.fetch = (input, init) => {
      const identity = core.activeAccount()?.identity;
      if (!identity?.proxy && !identity?.timezone) return originalFetch(input, init);
      const options = { ...(init ?? {}) };
      if (identity.proxy && !isLoopback(input)) options.proxy = identity.proxy;
      if (identity.timezone) {
        try {
          const headers = new Headers(
            options.headers ??
              (typeof input === "string" || input instanceof URL ? undefined : input?.headers),
          );
          headers.set("x-fb-timezone", identity.timezone);
          options.headers = headers;
        } catch {}
      }
      return originalFetch(input, options);
    };
    globalThis[FETCH_WRAPPED] = true;
  }

  let switching = Promise.resolve();
  const serialize = (step) => {
    const run = switching.then(step, step);
    switching = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const ensureTokens = (auth) => {
    freebuffCatalog?.setAuthToken?.(auth.token);
    sessions?.setAuthToken?.(auth.token);
  };

  const applyAccount = async (account, reason) =>
    serialize(async () => {
      const current = auth3.readAuth();
      if (
        current?.token === account.auth.token &&
        current?.user?.id === account.auth.user.id
      ) {
        core.setActive(account.id, { force: true });
        // Same identity, but a fresh sign-in still has to own its device key.
        await swapDeviceIdentity(account, null);
        return { changed: false, account };
      }
      const previousId = core.state.activeId;
      const live = Object.keys(sessions.snapshot()?.activeSessionsByThread ?? {});
      if (live.length > 0) await sessions.releaseAll().catch(() => {});
      try {
        core.recordSnapshot(previousId, sessions.snapshot(), { force: true });
      } catch {}
      await swapDeviceIdentity(account, previousId);
      core.setActive(account.id, { force: true });
      auth3.writeAuth({
        token: account.auth.token,
        user: { ...account.auth.user },
      });
      ensureTokens(account.auth);
      try {
        broadcastAuth();
      } catch {}
      try {
        for (const engine of registry2.all()) engine.reconcileFreebuffSessions?.();
      } catch {}
      sessions.refreshTier().catch(() => {});
      note(
        `switch → ${account.label} (${account.auth.user.email ?? account.id}) reason=${reason ?? "manual"}`,
      );
      return { changed: true, account };
    });

  // ── login path: swap identity before the first request is signed ──────
  // The hosted sign-in writes the token and immediately adopts the session,
  // which calls refreshTier(). Without this wrapper the first requests of a
  // freshly added account are signed with the previous account's device key.
  const poolOriginalAdoptSession =
    typeof adoptSession === "function" ? adoptSession : null;
  if (poolOriginalAdoptSession) {
    adoptSession = async (session, interactive) => {
      try {
        const account = session?.user?.id ? core.account(session.user.id) : null;
        if (account) await applyAccount(account, interactive ? "login" : "adopt");
      } catch (error) {
        note(`identity swap on adopt failed: ${error?.message ?? error}`);
      }
      return poolOriginalAdoptSession(session, interactive);
    };
  }

  // ── capture sign-ins ───────────────────────────────────────────────────
  const originalWriteAuth = auth3.writeAuth.bind(auth3);
  auth3.writeAuth = (auth) => {
    try {
      if (auth?.token && auth?.user?.id) core.upsertAuth(auth, { activate: true });
    } catch (error) {
      note(`could not record sign-in: ${error?.message ?? error}`);
    }
    return originalWriteAuth(auth);
  };

  // ── fail over when an admission is refused for account reasons ─────────
  const originalEnsure = SessionManager.prototype.ensure;
  SessionManager.prototype.ensure = async function (...args) {
    try {
      return await originalEnsure.apply(this, args);
    } catch (error) {
      const decision = core.failoverFor(error);
      if (!decision) throw error;
      note(
        `${decision.status} on ${core.activeAccount()?.label ?? decision.accountId}: ${
          String(error?.message ?? "").slice(0, 180)
        }`,
      );
      core.markCooldown(decision.accountId, decision.cooldown ?? {});
      if (!decision.retry) throw error;
      const next = core.chooseNext({ model: args[1] });
      if (!next) {
        note("no healthy account left for failover");
        throw error;
      }
      await applyAccount(next, `auto:${decision.status}`);
      return await originalEnsure.apply(this, args);
    }
  };

  // ── keep quota snapshots for the active account ────────────────────────
  sessions.onChange(() => {
    try {
      const active = core.activeAccount();
      if (active) core.recordSnapshot(active.id, sessions.snapshot());
    } catch {}
  });

  // ── control plane ──────────────────────────────────────────────────────
  const controlToken = __poolCrypto.randomBytes(24).toString("hex");
  const dashboardHtml = () => {
    try {
      return __poolFs.readFileSync(__poolDashPath, "utf8");
    } catch {
      return "<!doctype html><meta charset=utf-8><title>Freebuff pool</title><body style='font:14px system-ui;background:#111;color:#eee;padding:24px'><h1>Freebuff pool</h1><pre id=out></pre><script>fetch('/api/status?token=__POOL_TOKEN__').then(r=>r.text()).then(t=>out.textContent=t)</script>";
    }
  };

  const json = (value, status = 200) =>
    new Response(JSON.stringify(value, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "null",
      },
    });

  const loopbackOnly = (req, server) => {
    const address = server.requestIP(req)?.address ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  };
  const authorized = (url, req) =>
    url.searchParams.get("token") === controlToken ||
    req.headers.get("x-pool-token") === controlToken;

  const poolServer = (() => {
    const fetchHandler = async (req, server) => {
      const url = new URL(req.url);
      if (!loopbackOnly(req, server)) return new Response("forbidden", { status: 403 });
      if (url.pathname === "/") {
        if (!authorized(url, req)) {
          return new Response(
            "Open the dashboard URL from " + __poolFile + ".control.json",
            { status: 401 },
          );
        }
        return new Response(dashboardHtml().replaceAll("__POOL_TOKEN__", controlToken), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if (!authorized(url, req)) return json({ error: "unauthorized" }, 401);

      try {
        if (url.pathname === "/api/status") {
          const active = auth3.readAuth();
          return json({
            ...core.status(),
            session: active
              ? {
                  id: active.user?.id ?? null,
                  email: active.user?.email ?? null,
                  name: active.user?.name ?? null,
                }
              : null,
            authStorage: auth3.storageState?.() ?? null,
            statePath: desktopStatePath(),
            pid: process.pid,
            events: events.slice(-40),
          });
        }
        if (url.pathname === "/api/switch") {
          const id = url.searchParams.get("id") ?? "";
          const account = core.account(id);
          if (!account) return json({ error: `unknown account: ${id}` }, 404);
          const result = await applyAccount(account, "dashboard");
          return json({ ok: true, ...result, status: core.status() });
        }
        if (url.pathname === "/api/add") {
          const started = await login.start("pool");
          if (!started?.ok) return json({ error: started?.error ?? "login failed" }, 502);
          return json({ ok: true, url: started.launchUrl });
        }
        if (url.pathname === "/api/remove") {
          const id = url.searchParams.get("id") ?? "";
          if (id === auth3.readAuth()?.user?.id) {
            return json({ error: "refusing to remove the active account without switching first" }, 409);
          }
          core.remove(id);
          return json({ ok: true, status: core.status() });
        }
        if (url.pathname === "/api/label") {
          const id = url.searchParams.get("id") ?? "";
          core.rename(id, url.searchParams.get("label") ?? "");
          return json({ ok: true, status: core.status() });
        }
        if (url.pathname === "/api/clear") {
          const id = url.searchParams.get("id") ?? "";
          core.clearCooldown(id);
          return json({ ok: true, status: core.status() });
        }
        if (url.pathname === "/api/proxy") {
          const id = url.searchParams.get("id") ?? "";
          core.setProxy(id, url.searchParams.get("proxy") ?? "");
          return json({ ok: true, status: core.status() });
        }
        if (url.pathname === "/api/tz") {
          const id = url.searchParams.get("id") ?? "";
          core.setTimezone(id, url.searchParams.get("tz") ?? "");
          return json({ ok: true, status: core.status() });
        }
        if (url.pathname === "/api/reload") {
          core.load();
          return json({ ok: true, status: core.status() });
        }
        return json({ error: "unknown route" }, 404);
      } catch (error) {
        return json({ error: error?.message ?? String(error) }, 400);
      }
    };
    let server = null;
    const preferred = Number(process.env.FREEBUFF_POOL_PORT || 47821);
    for (const port of [preferred, 0]) {
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port, fetch: fetchHandler });
        break;
      } catch (error) {
        note(`control port ${port} failed: ${error?.message ?? error}`);
      }
    }
    return server;
  })();

  if (poolServer) {
    const url = `http://127.0.0.1:${poolServer.port}/?token=${controlToken}`;
    try {
      __poolFs.writeFileSync(
        `${__poolFile}.control.json`,
        `${JSON.stringify(
          {
            url,
            port: poolServer.port,
            token: controlToken,
            pid: process.pid,
            poolFile: __poolFile,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      note(`could not write control file: ${error?.message ?? error}`);
    }
    note(`control plane ${url}`);
  }

  // ── boot: honour the pool's active account ─────────────────────────────
  const bootAccount = core.activeAccount();
  if (bootAccount) {
    if (auth3.readAuth()?.token !== bootAccount.auth.token) {
      await applyAccount(bootAccount, "boot");
    } else {
      await swapDeviceIdentity(bootAccount, null);
    }
  } else {
    const seeded = auth3.readAuth();
    if (seeded?.token && seeded?.user?.id) {
      try {
        const created = core.upsertAuth(seeded, { activate: true });
        note("seeded pool from the profile's current sign-in");
        await swapDeviceIdentity(created, null);
      } catch {}
    }
  }
} catch (error) {
  console.warn(`[pool] runtime disabled: ${error?.stack ?? error}`);
}
