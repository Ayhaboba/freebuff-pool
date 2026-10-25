#!/usr/bin/env bash
# Install freebuff-pool on Linux (works on macOS too).
#
#   ./install.sh                 copy tooling to ~/.freebuff-pool, wire up the CLI, patch the app
#   ./install.sh --app <dir>     app bundle to patch (extracted AppImage root, the "squashfs-root" dir)
#   ./install.sh --no-patch      install the files only, leave the app bundle untouched
#   ./install.sh --revert        restore the original orchestrator.js from its backup
#
# Overrides: FREEBUFF_POOL_HOME (install prefix), FREEBUFF_BIN_DIR (CLI shims),
#            FREEBUFF_APP_DIR (app bundle)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL_HOME="${FREEBUFF_POOL_HOME:-$HOME/.freebuff-pool}"
BIN_DIR="${FREEBUFF_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="${FREEBUFF_APP_DIR:-}"
PATCH=1
REVERT=0

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)      APP_DIR="${2:?--app needs a path}"; shift 2 ;;
    --prefix)   POOL_HOME="${2:?--prefix needs a path}"; shift 2 ;;
    --bin)      BIN_DIR="${2:?--bin needs a path}"; shift 2 ;;
    --no-patch) PATCH=0; shift ;;
    --revert)   REVERT=1; PATCH=0; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "install: unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
command -v node >/dev/null 2>&1 || fail "node is required — https://nodejs.org"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
  || fail "node >= 18 is required (found $(node -v))"
if ! command -v python3 >/dev/null 2>&1; then
  say "install: warning: python3 not found — poolctl works, clone.py will not"
fi

# ---------------------------------------------------------------- copy the tooling
FILES=(
  pool-core.mjs poolctl.mjs pool-runtime.js dashboard.html
  patch.mjs install.mjs package.json clone.py
  run-pool.sh run-pool.ps1 install.sh install.ps1 README.md
)
mkdir -p "$POOL_HOME"
POOL_HOME="$(cd "$POOL_HOME" && pwd)"

if [[ "$POOL_HOME" != "$SRC" ]]; then
  for file in "${FILES[@]}"; do
    if [[ -f "$SRC/$file" ]]; then
      cp -f "$SRC/$file" "$POOL_HOME/$file"
    fi
  done
  if [[ -d "$SRC/tests" ]]; then
    mkdir -p "$POOL_HOME/tests"
    cp -f "$SRC"/tests/* "$POOL_HOME/tests/" 2>/dev/null || true
  fi
fi

# The pool home holds tokens and device keys: keep it private, files readable by
# owner only. Electron needs the execute bit on directories (SingletonLock).
chmod 700 "$POOL_HOME" 2>/dev/null || true
for file in "${FILES[@]}"; do
  [[ -f "$POOL_HOME/$file" ]] && chmod 600 "$POOL_HOME/$file" || true
done
chmod 700 "$POOL_HOME/run-pool.sh" "$POOL_HOME/clone.py" "$POOL_HOME/install.sh" 2>/dev/null || true

# ---------------------------------------------------------------- CLI shims
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/poolctl" <<SHIM
#!/usr/bin/env bash
exec node "$POOL_HOME/poolctl.mjs" "\$@"
SHIM
cat > "$BIN_DIR/fbclone" <<SHIM
#!/usr/bin/env bash
exec python3 "$POOL_HOME/clone.py" "\$@"
SHIM
chmod 755 "$BIN_DIR/poolctl" "$BIN_DIR/fbclone"

# ---------------------------------------------------------------- app bundle
detect_app() {
  local candidates=(
    "$HOME/freebuff-re/squashfs-root"
    "$HOME/Applications/Freebuff/squashfs-root"
    "/opt/freebuff/squashfs-root"
    "/opt/Freebuff"
    "/usr/lib/freebuff"
    "/usr/lib64/freebuff"
    "/usr/local/lib/freebuff"
    "/opt/freebuff-desktop"
  )
  local dir real
  for dir in "${candidates[@]}"; do
    if [[ -x "$dir/freebuff" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  # An extracted AppImage lives in a squashfs-root folder next to the image.
  local globs=("$HOME"/Applications/*/squashfs-root "$HOME"/*/**/squashfs-root)
  for real in "${globs[@]}"; do
    if [[ -x "$real/freebuff" ]]; then
      printf '%s\n' "$real"
      return 0
    fi
  done
  return 1
}

if [[ -z "$APP_DIR" ]]; then
  APP_DIR="$(detect_app || true)"
fi
# FREEBUFF_APP_DIR may point at the folder or straight at the binary.
if [[ -f "$APP_DIR" ]]; then
  APP_DIR="$(dirname "$APP_DIR")"
fi

if [[ $REVERT -eq 1 ]]; then
  [[ -n "$APP_DIR" ]] || fail "--revert needs --app <bundle dir>"
  node "$POOL_HOME/patch.mjs" "$APP_DIR/resources/orchestrator/orchestrator.js" --revert
elif [[ $PATCH -eq 1 ]]; then
  if [[ -n "$APP_DIR" && -f "$APP_DIR/resources/orchestrator/orchestrator.js" ]]; then
    node "$POOL_HOME/patch.mjs" "$APP_DIR/resources/orchestrator/orchestrator.js"
  else
    say "install: warning: app bundle not found, skipping the patch."
    say "  point at it with:  ./install.sh --app /path/to/squashfs-root"
    say "  (an AppImage extracts with: ./Freebuff-*.AppImage --appimage-extract)"
  fi
fi

# ---------------------------------------------------------------- summary
say ""
say "pool installed"
say "  home      $POOL_HOME"
say "  core      $POOL_HOME/pool-core.mjs"
say "  dashboard $POOL_HOME/dashboard.html"
say "  cli       $BIN_DIR/poolctl status"
say "  clones    $BIN_DIR/fbclone list"
say "  launch    $POOL_HOME/run-pool.sh"
if [[ -n "$APP_DIR" ]]; then
  say "  app       $APP_DIR"
else
  say "  app       (not detected — set FREEBUFF_APP_DIR)"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say ""; say "  note: $BIN_DIR is not on PATH — add it to use poolctl/fbclone" ;;
esac
say ""
say "next:"
say "  1) seed accounts:   node $POOL_HOME/poolctl.mjs import ~/.config/freebuff-desktop/state.json"
say "  2) start pooled:    $POOL_HOME/run-pool.sh"
say "  3) dashboard:       node $POOL_HOME/poolctl.mjs open"
