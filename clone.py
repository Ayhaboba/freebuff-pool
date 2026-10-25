#!/usr/bin/env python3
"""Manage persistent Freebuff clones.

Each clone gets its own Desktop state profile (state.json + projects/ +
account-skills/), its own --user-data-dir, and its own orchestrator lock, so it
never fights the installed app for the profile. Clones are started detached
(setsid on POSIX, a separate process tree on Windows), so they keep running
after the shell that spawned them exits.

  clone.py new NAME [--account EMAIL] [--source STATE.JSON] [--no-copy] [--wait SEC]
  clone.py list
  clone.py status NAME
  clone.py adopt
  clone.py stop NAME          # TERM to the process group, KILL after timeout
  clone.py rm NAME [--force]  # stop, then delete the profile directory
  clone.py log NAME [--tail N]
  clone.py send NAME "text"   # type into the clone's own window

Registry: ~/.freebuff-pool/clones.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

POOL_HOME = Path(os.environ.get("FREEBUFF_POOL_HOME", Path.home() / ".freebuff-pool"))
IS_WINDOWS = os.name == "nt"
APP_EXE = "freebuff.exe" if IS_WINDOWS else "freebuff"


def default_app_dir() -> Path:
    """Folder holding the app binary: extracted AppImage on Linux, install dir on Windows."""
    if IS_WINDOWS:
        roots = [Path(os.environ[key]) for key in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)") if os.environ.get(key)]
        for base in [r / "Programs" for r in roots] + roots:
            for name in ("freebuff", "Freebuff", "Freebuff Desktop"):
                if (base / name / APP_EXE).exists():
                    return base / name
        return roots[0] / "Programs" / "freebuff" if roots else Path("C:/Program Files/freebuff")
    return Path.home() / "freebuff-re" / "squashfs-root"


def default_live_state() -> Path:
    if IS_WINDOWS:
        return Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))) / "freebuff-desktop" / "state.json"
    return Path.home() / ".config" / "freebuff-desktop" / "state.json"


_app_env = os.environ.get("FREEBUFF_APP_DIR")
if _app_env:
    _app_path = Path(_app_env)
    APP = _app_path if _app_path.is_file() else _app_path / APP_EXE
else:
    APP = default_app_dir() / APP_EXE
APP_DIR = APP.parent
LIVE_STATE = Path(os.environ["FREEBUFF_LIVE_PROFILE"]) if os.environ.get("FREEBUFF_LIVE_PROFILE") else default_live_state()
POOL_ACCOUNTS = POOL_HOME / "pool.json"
REGISTRY = POOL_HOME / "clones.json"
READY_RE = re.compile(r"\[orchestrator-ready\] (\{.*\})")
SKIP_EXTRA = ("project.json", "project-id", "desktop-v2.db.browser.json")


# ---------------------------------------------------------------- registry
def load_registry() -> dict:
    if REGISTRY.exists():
        try:
            return json.loads(REGISTRY.read_text())
        except json.JSONDecodeError:
            pass
    return {}


def save_registry(data: dict) -> None:
    tmp = REGISTRY.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(REGISTRY)


# ---------------------------------------------------------------- processes
def _win_alive(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


_WIN_CMDLINES: dict[int, str] | None = None


def _win_cmdlines() -> dict[int, str]:
    """One CIM query for the whole process table: pid -> command line."""
    global _WIN_CMDLINES
    if _WIN_CMDLINES is not None:
        return _WIN_CMDLINES
    table: dict[int, str] = {}
    try:
        script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30,
        )
        for line in result.stdout.splitlines():
            pid_text, _, command = line.partition("\t")
            if pid_text.strip().isdigit():
                table[int(pid_text)] = command
    except (OSError, subprocess.SubprocessError):
        pass
    _WIN_CMDLINES = table
    return table


def process_cmdlines():
    """Every visible process as (pid, command line)."""
    if IS_WINDOWS:
        yield from _win_cmdlines().items()
        return
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        pid = int(proc.name)
        yield pid, cmdline(pid)


def stop_group(pid: int, force: bool) -> None:
    """Signal the whole tree. POSIX: the process group. Windows: taskkill walks the children."""
    if IS_WINDOWS:
        command = ["taskkill", "/PID", str(pid), "/T"] + (["/F"] if force else [])
        subprocess.run(command, capture_output=True, text=True)
        return
    os.killpg(pid, signal.SIGKILL if force else signal.SIGTERM)


def alive(pid: int) -> bool:
    if IS_WINDOWS:
        return _win_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # a zombie is not alive for our purposes
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1][:1]
        return state != "Z"
    except (FileNotFoundError, IndexError):
        return False


def cmdline(pid: int) -> str:
    if IS_WINDOWS:
        return _win_cmdlines().get(pid, "")
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def _flatten(value: str) -> str:
    # Windows quotes an argument as a whole when it contains spaces, and uses
    # backslashes; compare both sides in one shape.
    return value.replace("\\", "/").replace('"', "")


def owns(pid: int, electron_dir: Path) -> bool:
    return matches_user_data_dir(electron_dir, cmdline(pid))


def matches_user_data_dir(electron_dir: Path, text: str) -> bool:
    return _flatten(f"--user-data-dir={electron_dir}") in _flatten(text)


def clone_name_from(text: str) -> str | None:
    """Clone name carried by a `--user-data-dir=<pool>/<name>/electron` argument.

    Handles both separators, quoted paths with spaces and trailing flags, so it
    matches whatever the OS put in the command line.
    """
    # Windows quotes an argument as a whole when it contains spaces, and may
    # quote the path alone; dropping quotes first covers both styles.
    norm = text.replace("\\", "/").replace('"', "")
    home = str(POOL_HOME).replace("\\", "/").replace('"', "")
    marker = f"--user-data-dir={home}"
    if marker not in norm:
        return None
    tail = norm.split(marker, 1)[1]
    tail = tail.split(" --", 1)[0]  # anything after the first flag
    parts = [piece for piece in tail.strip().strip("/").split("/") if piece]
    if len(parts) < 2 or parts[1] != "electron":
        return None
    return parts[0]


def wait_ready(log_path: Path, timeout: float) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if log_path.exists():
            for line in log_path.read_text(errors="replace").splitlines():
                match = READY_RE.search(line)
                if match:
                    try:
                        return json.loads(match.group(1))
                    except json.JSONDecodeError:
                        pass
        time.sleep(0.25)
    return None


# ---------------------------------------------------------------- profile copy
def copy_database(src: Path, dst: Path, idle: bool = True) -> int:
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    target = sqlite3.connect(dst)
    try:
        source.backup(target)
        count = source.execute("select count(*) from threads").fetchone()[0] if _has_threads(source) else 0
    finally:
        target.close()
        source.close()
    if idle:
        calm_down(dst)
    return count


def calm_down(db_path: Path) -> dict:
    """Make the copy open quiet: full history, no turn to pick up, no queue to run.

    A thread copied mid-turn carries turn_state='running' plus pending briefs, so a fresh
    clone resumes work that belongs to the other window ("Picked up after a restart").
    """
    conn = sqlite3.connect(db_path)
    try:
        tables = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
        parked = 0
        if "threads" in tables:
            cols = {r[1] for r in conn.execute("pragma table_info(threads)")}
            sets = ["turn_state = 'idle'"]
            for column, value in (("turn_alive_at", "NULL"), ("pending_briefs", "NULL"),
                                  ("pending_briefs_diagnostic_key", "NULL"), ("auto_run", "'0'"),
                                  # no inherited claim: without these the copy adopts the other
                                  # window's hosted session and may re-admit ("Session remaining")
                                  ("freebuff_instance_id", "NULL"), ("freebuff_receipt_claim_id", "NULL")):
                if column in cols:
                    sets.append(f"{column} = {value}")
            parked = conn.execute(f"update threads set {', '.join(sets)} where turn_state != 'idle'").rowcount
            conn.execute("update threads set turn_state = 'idle'")
        dropped = 0
        for table in ("queue_items", "thread_deliveries"):
            if table in tables:
                dropped += conn.execute(f"delete from {table}").rowcount
        conn.commit()
        return {"parked": parked, "dropped": dropped}
    finally:
        conn.close()


def _has_threads(conn: sqlite3.Connection) -> bool:
    row = conn.execute("select 1 from sqlite_master where type='table' and name='threads'").fetchone()
    return row is not None


def build_profile(name: str, source: Path, copy_projects: bool, idle: bool = True) -> dict:
    profile = POOL_HOME / name
    if profile.exists():
        raise SystemExit(f"profile dir already exists: {profile} (use `rm {name}` first)")
    if not source.exists():
        raise SystemExit(f"source profile not found: {source}")
    root = profile
    root.mkdir(parents=True)
    (root / "electron").mkdir()

    # state.json is copied byte for byte: same account, same workspace, same tabs.
    shutil.copy2(source, root / "state.json")
    os.chmod(root / "state.json", 0o600)

    base = source.parent
    for extra in ("account-skills",):
        src_dir = base / extra
        if src_dir.is_dir():
            shutil.copytree(src_dir, root / extra)

    threads, calm = {}, {}
    if copy_projects:
        src_projects = base / "projects"
        if src_projects.is_dir():
            for project in sorted(src_projects.iterdir()):
                if not project.is_dir():
                    continue
                out = root / "projects" / project.name
                out.mkdir(parents=True)
                for extra in SKIP_EXTRA:
                    if (project / extra).exists():
                        shutil.copy2(project / extra, out / extra)
                db = project / "desktop-v2.db"
                if db.exists():
                    threads[project.name] = copy_database(db, out / "desktop-v2.db", idle=False)
                    if idle:
                        calm[project.name] = calm_down(out / "desktop-v2.db")

    return {"name": name, "root": str(root), "threads": threads, "calm": calm}


def swap_account(state_path: Path, email: str) -> dict:
    if not POOL_ACCOUNTS.exists():
        raise SystemExit(f"no pool file at {POOL_ACCOUNTS}; cannot switch account")
    pool = json.loads(POOL_ACCOUNTS.read_bytes())
    account = next((a for a in pool.get("accounts", []) if a["auth"]["user"]["email"] == email), None)
    if account is None:
        known = ", ".join(a["auth"]["user"]["email"] for a in pool.get("accounts", []))
        raise SystemExit(f"account {email} is not in the pool (known: {known})")
    state = json.loads(state_path.read_text())
    for host in list(state.get("authSessions") or {}):
        state["authSessions"][host] = {
            "token": account["auth"]["token"],
            "user": account["auth"]["user"],
        }
    if account.get("identity", {}).get("installId"):
        state["installId"] = account["identity"]["installId"]
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    os.chmod(state_path, 0o600)
    return account["auth"]["user"]


def account_of(state_path: Path) -> str:
    try:
        state = json.loads(state_path.read_text())
        return ", ".join(v["user"]["email"] for v in (state.get("authSessions") or {}).values()) or "signed out"
    except (OSError, KeyError, json.JSONDecodeError):
        return "unknown"


# ---------------------------------------------------------------- commands
def cmd_new(args) -> int:
    registry = load_registry()
    if args.name in registry and alive(registry[args.name]["pid"]):
        raise SystemExit(f"clone {args.name} is already running (pid {registry[args.name]['pid']})")

    source = Path(args.source).expanduser() if args.source else LIVE_STATE
    if not source.is_absolute():
        raise SystemExit(f"--source must be an absolute path to a state.json: {source}")
    info = build_profile(args.name, source, copy_projects=not args.no_copy, idle=not args.keep_running)
    root = Path(info["root"])
    state_path = root / "state.json"

    if args.account:
        user = swap_account(state_path, args.account)
        account = f"{user['email']} ({user.get('name', '')})"
    else:
        account = account_of(state_path)

    log_path = root / "clone.log"
    if not APP.exists():
        raise SystemExit(f"no Freebuff binary at {APP} — set FREEBUFF_APP_DIR")
    env = dict(os.environ)
    env["FREEBUFF_DESKTOP_STATE_PATH"] = str(state_path)
    env.pop("FREEBUFF_POOL_CORE", None)  # no token juggling: the profile is frozen
    popen_kwargs = dict(
        env=env,
        cwd=str(root),
        stdin=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        close_fds=True,
    )
    if not IS_WINDOWS:
        popen_kwargs["start_new_session"] = True  # survives this script and its terminal
    with open(log_path, "wb") as log:
        process = subprocess.Popen(
            [str(APP), f"--user-data-dir={root / 'electron'}"],
            stdout=log,
            **popen_kwargs,
        )

    ready = wait_ready(log_path, args.wait)
    entry = {
        "name": args.name,
        "pid": process.pid,
        "profile": str(root),
        "electron": str(root / "electron"),
        "state": str(state_path),
        "account": account,
        "log": str(log_path),
        "port": (ready or {}).get("port"),
        "created": int(time.time() * 1000),
        "threads": info["threads"],
        "source": str(source),
    }
    registry[args.name] = entry
    save_registry(registry)

    if ready:
        print(f"{args.name}: pid {process.pid}, orchestrator {ready.get('pid')} on port {ready.get('port')}, account {account}")
    else:
        print(f"{args.name}: pid {process.pid} started, orchestrator did not report ready within {args.wait:.0f}s — see {log_path}")
    return 0


def cmd_list(_args) -> int:
    registry = load_registry()
    stamped = adopt(registry, save=False)
    if not registry:
        print("no clones")
        return 0
    width = max(len(n) for n in registry)
    print(f"{'name'.ljust(width)}  {'state':7} {'pid':>8} {'port':>6}  account")
    for name, entry in sorted(registry.items()):
        up = alive(entry["pid"]) and owns(entry["pid"], Path(entry["electron"]))
        print(f"{name.ljust(width)}  {'up' if up else 'down':7} {entry['pid']:>8} {str(entry.get('port') or '-'):>6}  {entry.get('account', '?')}")
    if stamped:
        save_registry(registry)
    return 0


def cmd_status(args) -> int:
    registry = load_registry()
    entry = registry.get(args.name)
    if not entry:
        raise SystemExit(f"unknown clone: {args.name}")
    up = alive(entry["pid"]) and owns(entry["pid"], Path(entry["electron"]))
    print(json.dumps({**entry, "alive": up}, ensure_ascii=False, indent=2))
    return 0 if up else 1


def adopt(registry: dict, save: bool = True) -> list[str]:
    """Register clones that are running but missing from the registry."""
    added = []
    for pid, text in process_cmdlines():
        name = clone_name_from(text)
        if name is None:
            continue
        if name in registry and registry[name]["pid"] == pid:
            continue
        if name in registry and alive(registry[name]["pid"]):
            continue
        root = POOL_HOME / name
        log_path = root / "clone.log"
        port = None
        if log_path.exists():
            for line in log_path.read_text(errors="replace").splitlines():
                match = READY_RE.search(line)
                if match:
                    try:
                        port = json.loads(match.group(1)).get("port")
                    except json.JSONDecodeError:
                        pass
        entry = registry.get(name, {"name": name, "created": int(time.time() * 1000), "threads": {}})
        entry.update({
            "pid": pid,
            "profile": str(root),
            "electron": str(root / "electron"),
            "state": str(root / "state.json"),
            "account": account_of(root / "state.json"),
            "log": str(log_path),
            "port": port,
        })
        registry[name] = entry
        added.append(name)
    if added and save:
        save_registry(registry)
    return added


def cmd_adopt(_args) -> int:
    registry = load_registry()
    added = adopt(registry)
    print(f"adopted: {', '.join(added)}" if added else "nothing new to adopt")
    return 0


def cmd_stop(args) -> int:
    registry = load_registry()
    entry = registry.get(args.name)
    if not entry:
        raise SystemExit(f"unknown clone: {args.name}")
    pid = entry["pid"]
    if not alive(pid):
        print(f"{args.name}: already down")
        return 0
    if not owns(pid, Path(entry["electron"])):
        raise SystemExit(f"pid {pid} does not belong to {args.name}; refusing to signal it")
    try:
        stop_group(pid, force=False)  # the clone leads its own process group/tree
    except ProcessLookupError:
        pass
    deadline = time.time() + args.timeout
    while time.time() < deadline and alive(pid):
        time.sleep(0.2)
    if alive(pid):
        stop_group(pid, force=True)
        time.sleep(0.5)
    print(f"{args.name}: stopped" if not alive(pid) else f"{args.name}: still alive as {pid}")
    return 0 if not alive(pid) else 1


def cmd_rm(args) -> int:
    registry = load_registry()
    entry = registry.get(args.name)
    if entry and alive(entry["pid"]) and not args.force:
        raise SystemExit(f"{args.name} is running; stop it first or pass --force")
    if entry and alive(entry["pid"]):
        cmd_stop(argparse.Namespace(name=args.name, timeout=10.0))
    root = Path(entry["profile"]) if entry else POOL_HOME / args.name
    if root.exists():
        shutil.rmtree(root)
    registry.pop(args.name, None)
    save_registry(registry)
    print(f"{args.name}: removed ({root})")
    return 0


WINDOW_TITLE = "Freebuff Desktop"


def xdo(*args: str, check: bool = True) -> str:
    result = subprocess.run(["xdotool", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise SystemExit(f"xdotool {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _require(tool: str) -> None:
    if shutil.which(tool) is None:
        raise SystemExit(f"{tool} is required for window automation (apt install {tool})")


def desktop_window(pid: int) -> int | None:
    """Handle of the clone's window: X11 id on Linux, HWND on Windows."""
    if IS_WINDOWS:
        return _win_desktop_window(pid)
    _require("xdotool")
    out = subprocess.run(["xdotool", "search", "--pid", str(pid)], capture_output=True, text=True).stdout
    for token in out.split():
        name = subprocess.run(["xdotool", "getwindowname", token], capture_output=True, text=True).stdout.strip()
        if name == WINDOW_TITLE:
            return int(token)
    return None


def _win_desktop_window(pid: int) -> int | None:
    script = (
        '$p = Get-Process -Id %d -ErrorAction SilentlyContinue; '
        'if ($p) { "$($p.MainWindowHandle)`t$($p.MainWindowTitle)" }'
    ) % pid
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    handle, _, title = result.stdout.strip().partition("\t")
    if title == WINDOW_TITLE and handle.isdigit() and int(handle):
        return int(handle)
    return None


def window_box(window: int) -> tuple[int, int, int, int] | None:
    """(x, y, width, height) of the clone window in screen coordinates."""
    if IS_WINDOWS:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user32.GetWindowRect.restype = wintypes.BOOL
        rect = wintypes.RECT()
        if not user32.GetWindowRect(window, ctypes.byref(rect)):
            return None
        return (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
    geometry = dict(
        line.split("=", 1)
        for line in subprocess.run(["xdotool", "getwindowgeometry", "--shell", str(window)],
                                   capture_output=True, text=True).stdout.splitlines()
        if "=" in line
    )
    if "X" not in geometry:
        return None
    return (int(geometry["X"]), int(geometry["Y"]), int(geometry["WIDTH"]), int(geometry["HEIGHT"]))


def focus_window(window: int) -> None:
    if IS_WINDOWS:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.ShowWindow(window, 9)  # SW_RESTORE, in case it is minimised
        user32.SetForegroundWindow(window)
        return
    subprocess.run(["xdotool", "windowactivate", "--sync", str(window)], check=False)


def click_at(x: int, y: int) -> None:
    if IS_WINDOWS:
        import ctypes

        user32 = ctypes.windll.user32
        user32.SetCursorPos(x, y)
        user32.mouse_event(0x0002, 0, 0, 0, 0)  # left button down
        user32.mouse_event(0x0004, 0, 0, 0, 0)  # left button up
        return
    subprocess.run(["xdotool", "mousemove", str(x), str(y), "click", "1"], check=False)


def set_clipboard(text: str) -> None:
    if IS_WINDOWS:
        _win_set_clipboard(text)
        return
    result = subprocess.run(["xclip", "-selection", "clipboard", "-i"], input=text.encode(), check=False)
    if result.returncode != 0:
        raise SystemExit("xclip is required to paste Cyrillic/Unicode text")


def _win_set_clipboard(text: str) -> None:
    """Write CF_UNICODETEXT straight through Win32: no codepage round trip, so Cyrillic survives."""
    import ctypes
    from ctypes import wintypes

    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.SetClipboardData.argtypes = [ctypes.c_uint, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalAlloc.restype = wintypes.HANDLE
    kernel32.GlobalAlloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalFree.argtypes = [wintypes.HANDLE]

    payload = (text + "\0").encode("utf-16-le")
    opened = False
    for _ in range(20):
        if user32.OpenClipboard(None):
            opened = True
            break
        time.sleep(0.05)
    if not opened:
        raise SystemExit("the clipboard is busy — retry in a moment")
    try:
        user32.EmptyClipboard()
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(payload))
        if not handle:
            raise SystemExit("GlobalAlloc failed")
        locked = kernel32.GlobalLock(handle)
        if not locked:
            kernel32.GlobalFree(handle)
            raise SystemExit("GlobalLock failed")
        ctypes.memmove(locked, payload, len(payload))
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            raise SystemExit("SetClipboardData failed")
    finally:
        user32.CloseClipboard()


def paste_from_clipboard() -> None:
    """Select the input, then paste whatever set_clipboard loaded."""
    if IS_WINDOWS:
        import ctypes

        VK_CONTROL, VK_A, VK_V, KEYEVENTF_KEYUP = 0x11, 0x41, 0x56, 0x0002
        user32 = ctypes.windll.user32

        def chord(virtual_key: int) -> None:
            user32.keybd_event(VK_CONTROL, 0, 0, 0)
            user32.keybd_event(virtual_key, 0, 0, 0)
            user32.keybd_event(virtual_key, 0, KEYEVENTF_KEYUP, 0)
            user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)

        chord(VK_A)
        time.sleep(0.1)
        chord(VK_V)
        return
    subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+a"], check=False)
    subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+v"], check=False)


def press_return() -> None:
    if IS_WINDOWS:
        import ctypes

        VK_RETURN, KEYEVENTF_KEYUP = 0x0D, 0x0002
        ctypes.windll.user32.keybd_event(VK_RETURN, 0, 0, 0)
        ctypes.windll.user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
        return
    subprocess.run(["xdotool", "key", "--clearmodifiers", "Return"], check=False)


def newest_thread(db_path: Path) -> str | None:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        row = conn.execute("select id from threads order by updated_at desc limit 1").fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def message_count(db_path: Path, thread_id: str) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return conn.execute("select count(*) from messages where thread_id = ?", (thread_id,)).fetchone()[0]
    finally:
        conn.close()


def cmd_send(args) -> int:
    """Type a prompt into a running clone through its own window (paste + Enter)."""
    registry = load_registry()
    entry = registry.get(args.name)
    if not entry:
        raise SystemExit(f"unknown clone: {args.name}")
    pid = entry["pid"]
    if not alive(pid) or not owns(pid, Path(entry["electron"])):
        raise SystemExit(f"{args.name} is not running")

    window = desktop_window(pid)
    if window is None:
        raise SystemExit(f"no {WINDOW_TITLE} window for {args.name} (pid {pid})")

    box = window_box(window)
    if box is None:
        raise SystemExit(f"cannot measure the window for {args.name} (pid {pid})")
    x = box[0] + box[2] // 2
    y = box[1] + box[3] - 90

    profile = Path(entry["profile"])
    db, thread = None, args.thread
    candidates = sorted((profile / "projects").glob("*/desktop-v2.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    if candidates:
        db = candidates[0]
        thread = thread or newest_thread(db)
    before = message_count(db, thread) if db and thread else None

    focus_window(window)
    time.sleep(0.4)
    click_at(x, y)
    time.sleep(0.4)

    set_clipboard(args.text)
    time.sleep(0.3)
    paste_from_clipboard()
    time.sleep(0.6)
    if not args.dry:
        press_return()

    if args.dry:
        print(f"{args.name}: pasted into window {window}, not sent (--dry)")
        return 0

    deadline = time.time() + args.wait
    while time.time() < deadline:
        if db and thread and message_count(db, thread) > (before or 0):
            print(f"{args.name}: sent to thread {thread} (messages {before} -> {message_count(db, thread)})")
            return 0
        time.sleep(0.3)
    print(f"{args.name}: pasted and pressed Enter, but the message has not landed yet — check the window")
    return 1


def cmd_log(args) -> int:
    registry = load_registry()
    entry = registry.get(args.name)
    if not entry:
        raise SystemExit(f"unknown clone: {args.name}")
    path = Path(entry["log"])
    if not path.exists():
        raise SystemExit(f"no log at {path}")
    lines = [l for l in path.read_text(errors="replace").splitlines() if "Fontconfig warning" not in l]
    print("\n".join(lines[-args.tail:]))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="clone.py", description="manage persistent Freebuff clones")
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="copy the profile and launch a clone")
    new.add_argument("name")
    new.add_argument("--account", help="email from pool.json to log the clone into")
    new.add_argument("--source", default=None, help="state.json to copy (default: the installed app's live profile)")
    new.add_argument("--no-copy", action="store_true", help="skip projects/ (empty chat list)")
    new.add_argument("--keep-running", action="store_true",
                     help="copy turn/queue state as-is (the clone resumes the other window's turn)")
    new.add_argument("--wait", type=float, default=25.0, help="seconds to wait for orchestrator-ready")
    new.set_defaults(func=cmd_new)

    sub.add_parser("list", help="show clones and whether they are up").set_defaults(func=cmd_list)
    sub.add_parser("adopt", help="register already-running clones").set_defaults(func=cmd_adopt)

    status = sub.add_parser("status", help="details for one clone")
    status.add_argument("name")
    status.set_defaults(func=cmd_status)

    stop = sub.add_parser("stop", help="stop one clone by pid (never by pattern)")
    stop.add_argument("name")
    stop.add_argument("--timeout", type=float, default=10.0)
    stop.set_defaults(func=cmd_stop)

    rm = sub.add_parser("rm", help="stop and delete a clone profile")
    rm.add_argument("name")
    rm.add_argument("--force", action="store_true")
    rm.set_defaults(func=cmd_rm)

    send = sub.add_parser("send", help="paste a prompt into a running clone's window and send it")
    send.add_argument("name")
    send.add_argument("text")
    send.add_argument("--thread", default=None, help="thread id (default: newest in the newest project db)")
    send.add_argument("--dry", action="store_true", help="paste without pressing Enter")
    send.add_argument("--wait", type=float, default=20.0, help="seconds to wait for the message to land")
    send.set_defaults(func=cmd_send)

    log = sub.add_parser("log", help="tail a clone's log")
    log.add_argument("name")
    log.add_argument("--tail", type=int, default=40)
    log.set_defaults(func=cmd_log)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
