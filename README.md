# freebuff-pool

A multi-account pool for Freebuff Desktop. One window, several identities: when
the active account hits a server-side limit (`rate_limited`, `spend_limited`,
`session_limit_reached`, …) the orchestrator releases the session, switches to
the next account with headroom, and keeps going. A token-gated dashboard on
loopback shows every account, its quota and its cooldown state.

```
Freebuff UI ──► orchestrator (patched)
                  │
                  ├─ AuthStore ──writeAuth──► pool.upsertAuth
                  │      │                         │
                  │      └─ readAuth() = active    ▼
                  │                          pool-core.mjs   ◄── pool.json
                  ├─ SessionManager.ensure
                  │      └─ on quota/busy error ──► failover → next account
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

## Requirements

- Node.js ≥ 18 (the control plane and CLI)
- Python 3.10+ (only for `clone.py`)
- A Freebuff Desktop build whose `resources/orchestrator/orchestrator.js` can be
  patched — an extracted AppImage on Linux, the install folder on Windows.

## Install — Linux

```bash
git clone https://github.com/<you>/freebuff-pool.git
cd freebuff-pool
./install.sh                    # finds the app bundle, copies, patches
./install.sh --app /path/to/squashfs-root   # or point at it explicitly
```

What it does:

1. checks `node` and `python3`,
2. copies the tooling to `~/.freebuff-pool` (owner-only permissions),
3. drops `poolctl` and `fbclone` shims into `~/.local/bin`,
4. patches `orchestrator.js` — the original is kept as `orchestrator.js.pool-orig`.

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
git clone https://github.com/<you>/freebuff-pool.git
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
npm test        # node --test tests/pool-core.test.mjs
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
