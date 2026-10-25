# Launch the patched Freebuff Desktop against an isolated pool profile (Windows).
#
#   .\run-pool.ps1                 # shared mode: the installed app's own profile
#   .\run-pool.ps1 -Isolated       # pool-only profile under ~/.freebuff-pool
#
# Env overrides: FREEBUFF_APP_DIR, FREEBUFF_POOL_HOME, FREEBUFF_POOL_PROFILE,
#                FREEBUFF_POOL_FILE, FREEBUFF_POOL_PORT, FREEBUFF_POOL_SHARED
param(
  [switch]$Isolated,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AppArgs
)

$ErrorActionPreference = "Stop"

$PoolHome = if ($env:FREEBUFF_POOL_HOME) { $env:FREEBUFF_POOL_HOME } else { Join-Path $env:USERPROFILE ".freebuff-pool" }

function Find-AppDir {
  if ($env:FREEBUFF_APP_DIR) { return $env:FREEBUFF_APP_DIR }
  $roots = @()
  foreach ($key in @("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $roots += $value }
  }
  $search = @()
  foreach ($root in $roots) {
    $search += (Join-Path $root "Programs")
    $search += $root
  }
  foreach ($base in $search) {
    foreach ($name in @("freebuff", "Freebuff", "Freebuff Desktop")) {
      $candidate = Join-Path (Join-Path $base $name) "freebuff.exe"
      if (Test-Path $candidate) { return (Split-Path -Parent $candidate) }
    }
  }
  throw "freebuff.exe not found - set FREEBUFF_APP_DIR to its folder"
}

$AppDir = Find-AppDir
# FREEBUFF_APP_DIR may point at the folder or straight at freebuff.exe.
$Exe = if (Test-Path $AppDir -PathType Leaf) { $AppDir } else { Join-Path $AppDir "freebuff.exe" }
if (-not (Test-Path $Exe)) { throw "no freebuff binary at $Exe (set FREEBUFF_APP_DIR)" }

# Shared mode (default): run against the installed app's profile, so projects,
# chats and workspace are the same ones. Only one client may own that profile,
# so the installed app has to be closed first.
$shared = ($env:FREEBUFF_POOL_SHARED -ne "0") -and (-not $Isolated) -and (-not $env:FREEBUFF_POOL_PROFILE)
if ($shared) {
  $roaming = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
  $ProfilePath = Join-Path (Join-Path $roaming "freebuff-desktop") "state.json"
} else {
  $ProfilePath = if ($env:FREEBUFF_POOL_PROFILE) { $env:FREEBUFF_POOL_PROFILE } else { Join-Path $PoolHome "state.json" }
}

$env:FREEBUFF_DESKTOP_STATE_PATH = $ProfilePath
$env:FREEBUFF_POOL_FILE = if ($env:FREEBUFF_POOL_FILE) { $env:FREEBUFF_POOL_FILE } else { Join-Path $PoolHome "pool.json" }
$env:FREEBUFF_POOL_CORE = if ($env:FREEBUFF_POOL_CORE) { $env:FREEBUFF_POOL_CORE } else { Join-Path $PoolHome "pool-core.mjs" }
$env:FREEBUFF_POOL_DASHBOARD = if ($env:FREEBUFF_POOL_DASHBOARD) { $env:FREEBUFF_POOL_DASHBOARD } else { Join-Path $PoolHome "dashboard.html" }
$env:FREEBUFF_POOL_PORT = if ($env:FREEBUFF_POOL_PORT) { $env:FREEBUFF_POOL_PORT } else { "47821" }

$ProfileDir = Split-Path -Parent $ProfilePath
New-Item -ItemType Directory -Force -Path $ProfileDir, $PoolHome | Out-Null

$ElectronDir = if ($env:FREEBUFF_POOL_ELECTRON_DIR) { $env:FREEBUFF_POOL_ELECTRON_DIR } else { Join-Path $PoolHome "electron" }

& $Exe "--user-data-dir=$ElectronDir" @AppArgs
