#!/usr/bin/env bash
# Launch the patched Freebuff Desktop against an isolated pool profile.
set -euo pipefail

APP_DIR="${FREEBUFF_APP_DIR:-$HOME/freebuff-re/squashfs-root}"
POOL_HOME="${FREEBUFF_POOL_HOME:-$HOME/.freebuff-pool}"

# Shared mode (default): run against the installed app's profile, so projects,
# chats and workspace are the same ones. Only one client may own that profile,
# so the installed app has to be closed first.
if [[ "${FREEBUFF_POOL_SHARED:-1}" == "1" && -z "${FREEBUFF_POOL_PROFILE:-}" ]]; then
  PROFILE="$HOME/.config/freebuff-desktop/state.json"
else
  PROFILE="${FREEBUFF_POOL_PROFILE:-$POOL_HOME/state.json}"
fi

export FREEBUFF_DESKTOP_STATE_PATH="$PROFILE"
export FREEBUFF_POOL_FILE="${FREEBUFF_POOL_FILE:-$POOL_HOME/pool.json}"
export FREEBUFF_POOL_CORE="${FREEBUFF_POOL_CORE:-$POOL_HOME/pool-core.mjs}"
export FREEBUFF_POOL_DASHBOARD="${FREEBUFF_POOL_DASHBOARD:-$POOL_HOME/dashboard.html}"
export FREEBUFF_POOL_PORT="${FREEBUFF_POOL_PORT:-47821}"
# Failover policy: a concurrency refusal is answered by the tab's own "Use it
# here" takeover, and a live hour is never released to buy time on the next
# account. Set either to the opposite value to restore the old behaviour.
export FREEBUFF_POOL_FAILOVER_ON_BUSY="${FREEBUFF_POOL_FAILOVER_ON_BUSY:-0}"
export FREEBUFF_POOL_PROTECT_HOURS="${FREEBUFF_POOL_PROTECT_HOURS:-1}"
# Keep a live hour across a quit (updater semantics): sessions are not released
# on shutdown and the next boot re-adopts them. Set 0 to release on quit instead.
export FREEBUFF_POOL_HOLD_HOURS="${FREEBUFF_POOL_HOLD_HOURS:-1}"

mkdir -p "$(dirname "$PROFILE")" "$POOL_HOME"
chmod 700 "$(dirname "$PROFILE")" "$POOL_HOME" 2>/dev/null || true

if [[ ! -x "$APP_DIR/freebuff" ]]; then
  echo "no freebuff binary at $APP_DIR (set FREEBUFF_APP_DIR)" >&2
  exit 1
fi

exec "$APP_DIR/freebuff" --user-data-dir="${FREEBUFF_POOL_ELECTRON_DIR:-$POOL_HOME/electron}" "$@"
