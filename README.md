# freebuff-pool

A multi-account pool for Freebuff Desktop. One window, several identities: when
the active account's allowance is out (`rate_limited`, `spend_limited`) the
orchestrator releases the session, switches to the next account with headroom,
and keeps going. Concurrency refusals ("this hour is in use in another tab") are
left to the tab's own **Use it here** takeover, and a live hour is never released
to buy time on another account. A token-gated dashboard on loopback shows every
account, its quota and its cooldown state.

```
Freebuff UI ──► orchestrator (patched)
                  │
                  ├─ AuthStore ──writeAuth──► pool.upsertAuth
                  │      │                         │
                  │      └─ readAuth() = active    ▼
                  │                          pool-core.mjs   ◄── pool.json
                  ├─ SessionManager.ensure
                  │      └─ quota refusal, no live hour ──► failover → next account
                  └─ loopback control plane :47821 (token-gated) ──► dashboard
```

Three pieces ship here:

| File | What it is |
|---|---|
| `pool-core.mjs` | Pure pool state: accounts, cooldowns, failover order. No network, no Electron. |
| `pool-runtime.js` | Injected into the orchestrator bundle by `patch.mjs`; wires AuthStore/SessionManager to the pool and serves the control plane. |
| `poolctl.mjs` | Shell CLI: status, switch, add, proxy, timezone, import. |
| `clone.py` | Independent clones of the whole profile — each with its own state, projects and orchestrator lock. |
| `dashboard.html` | The control-plane UI, served from loopback only. |

## Failover policy

A refusal only moves the pool when another account actually helps:

| Refusal | What happens |
|---|---|
| `rate_limited`, `spend_limited` — the account's allowance is out | cooldown until the reset, switch to the next account with headroom, retry once |
| `rate_limited`, `spend_limited` — while this account still holds a live hour | recorded on the account, error returned to the UI; the hour is not released |
| `purchase_in_use`, `premium_slot_taken`, `purchase_capacity`, `session_limit_reached` (concurrency) | recorded, error returned to the UI so the tab's **Use it here** takeover runs — the hour moves here, on the same account, without a new charge |
| `banned`, `unauthenticated`, `account_changed`, `country_blocked` | parked; never chosen again automatically |
| `ip_capped`, `model_unavailable`, everything else | not failed over |

`hasLiveHour()` reads the session snapshot: any active session, or a purchased
hour a tab is holding. That is exactly what a switch releases, so no refusal can
cost it. Manual switches (dashboard, `poolctl switch`, adding an account) still
release the current hour on purpose — the UI then offers it back as "Resume your
purchased hour".

### Hours across a restart

A stock quit releases every session, so a live hour ends there and the next
launch buys a new one (the server settles the old one in credit). The pool holds
them instead, using the same flag the updater sets before it relaunches
(`sessions.holdForRestart()`): the session stays live server-side and the next
boot re-adopts the thread's persisted instance id, remaining minutes intact.
Closed tabs, logout and account switches still release on purpose.

Escape hatches for the stock behaviour: `FREEBUFF_POOL_FAILOVER_ON_BUSY=1`
(fail over on concurrency too), `FREEBUFF_POOL_PROTECT_HOURS=0` (let a quota
refusal release a live hour) and `FREEBUFF_POOL_HOLD_HOURS=0` (release sessions
on quit again). `run-pool.sh` / `run-pool.ps1` set all three defaults
explicitly, the dashboard header prints the active policy, and `/api/status`
exposes it as `policy`.

## Requirements

- Node.js ≥ 18 (the control plane and CLI)
- Python 3.10+ (only for `clone.py`)
- A Freebuff Desktop build whose `resources/orchestrator/orchestrator.js` can be
  patched — an extracted AppImage on Linux, the install folder on Windows.

## Install — Linux

```bash
git clone https://github.com/Ayhaboba/freebuff-pool.git
cd freebuff-pool
./install.sh                    # finds the app bundle, copies, patches
./install.sh --app /path/to/squashfs-root   # or point at it explicitly
```

What it does:

1. checks `node` and `python3`,
2. copies the tooling to `~/.freebuff-pool` (owner-only permissions),
3. drops `poolctl` and `fbclone` shims into `~/.local/bin`,
4. patches `orchestrator.js` — the original is kept as `orchestrator.js.pool-orig`.

After the pool source changes, refresh an already patched bundle without
reverting: `node patch.mjs <path to orchestrator.js>` swaps the injected runtime
in place (and syntax-checks the result before writing). A running client keeps
the runtime it booted with — restart it to pick up the new one; the boot log line
`policy: …` confirms which version is live.

An AppImage has to be extracted once: `./Freebuff-*.AppImage --appimage-extract`.

```bash
node ~/.freebuff-pool/poolctl.mjs import ~/.config/freebuff-desktop/state.json  # seed accounts
~/.freebuff-pool/run-pool.sh                     # start the pooled window
node ~/.freebuff-pool/poolctl.mjs open           # dashboard URL
```

`run-pool.sh` runs in **shared** mode by default: same profile, projects and
chats as the installed app, so close the installed client first. For a separate
profile, `FREEBUFF_POOL_SHARED=0 ./run-pool.sh`.

## Install — Windows

```powershell
git clone https://github.com/Ayhaboba/freebuff-pool.git
cd freebuff-pool
powershell -ExecutionPolicy Bypass -File .\install.ps1
# or: .\install.ps1 -AppDir "$env:LOCALAPPDATA\Programs\freebuff"
```

Same four steps. The shims (`poolctl.cmd`, `fbclone.cmd`) land in
`~\.freebuff-pool\bin`, which the installer appends to your user `PATH`.

```powershell
node ~\.freebuff-pool\poolctl.mjs import "$env:APPDATA\freebuff-desktop\state.json"
powershell -ExecutionPolicy Bypass -File ~\.freebuff-pool\run-pool.ps1
node ~\.freebuff-pool\poolctl.mjs open
```

`run-pool.ps1 -Isolated` gives the pooled window its own profile instead of the
installed app's one.

The ports that make the Windows side work: process inspection goes through
`Get-CimInstance Win32_Process` instead of `/proc`, process trees are stopped
with `taskkill /T` instead of `killpg`, and `clone.py send` drives the window
through Win32 (`SetForegroundWindow`, `SetClipboardData` as `CF_UNICODETEXT`,
`keybd_event`) instead of `xdotool`/`xclip`.

## CLI

```bash
poolctl status                 # accounts, cooldowns, quota, live dashboard URL
poolctl switch <id|email|label>
poolctl add                    # prints a sign-in URL for one more account
poolctl remove <id|email|label>
poolctl label <id|email> <new label>
poolctl proxy <id|email> <http://host:port|socks5://host:port|none>
poolctl tz <id|email> <Europe/Berlin|+01:00|none>
poolctl clear <id|email>       # drop a cooldown early
poolctl import <state.json>    # seed the pool from an existing profile
poolctl events | open
```

```bash
fbclone new NAME [--account EMAIL] [--source STATE.JSON] [--no-copy]
fbclone list | status NAME | adopt | log NAME [--tail N]
fbclone stop NAME | rm NAME [--force]
fbclone send NAME "text" [--dry]   # type into the clone's window
```

## Tests

```bash
npm test                            # node --test tests/pool-core.test.mjs
python3 tests/test_clone_cmdline.py # clone.py argv handling
```

## Uninstall

```bash
./install.sh --revert           # Linux: restore orchestrator.js from the backup
.\install.ps1 -Revert           # Windows
rm -rf ~/.freebuff-pool         # then remove the poolctl/fbclone shims
```

## Files that stay local

`state.json`, `pool.json`, `clones.json`, `*.log` and every `electron/` or
clone profile directory are runtime state: they hold auth tokens, device
private keys and account addresses. `.gitignore` keeps all of them out of the
repository — keep it that way when adding patterns.
