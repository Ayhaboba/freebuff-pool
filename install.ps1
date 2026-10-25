# Install freebuff-pool on Windows.
#
#   .\install.ps1                  copy tooling to ~\.freebuff-pool, wire up the CLI, patch the app
#   .\install.ps1 -AppDir <dir>    app bundle to patch (the folder holding freebuff.exe)
#   .\install.ps1 -NoPatch         install the files only, leave the bundle untouched
#   .\install.ps1 -Revert          restore the original orchestrator.js from its backup
#
# Overrides: FREEBUFF_POOL_HOME (install prefix), FREEBUFF_BIN_DIR (CLI shims),
#            FREEBUFF_APP_DIR (app bundle)
param(
  [string]$AppDir = "",
  [string]$Prefix = "",
  [string]$BinDir = "",
  [switch]$NoPatch,
  [switch]$Revert
)

$ErrorActionPreference = "Stop"
$Src = $PSScriptRoot

$PoolHome = if ($Prefix) { $Prefix } elseif ($env:FREEBUFF_POOL_HOME) { $env:FREEBUFF_POOL_HOME } else { Join-Path $env:USERPROFILE ".freebuff-pool" }
$Bin = if ($BinDir) { $BinDir } elseif ($env:FREEBUFF_BIN_DIR) { $env:FREEBUFF_BIN_DIR } else { Join-Path $PoolHome "bin" }
if (-not $AppDir) { $AppDir = $env:FREEBUFF_APP_DIR }

# ---------------------------------------------------------------- prerequisites
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node is required - https://nodejs.org" }
$version = (node -v) -replace "^v", ""
$major = [int]($version.Split(".")[0])
if ($major -lt 18) { throw "node >= 18 is required (found $version)" }
if (-not (Get-Command python -ErrorAction SilentlyContinue) -and -not (Get-Command py -ErrorAction SilentlyContinue)) {
  Write-Host "install: warning: python not found - poolctl works, clone.py will not"
}

# ---------------------------------------------------------------- copy the tooling
$Files = @(
  "pool-core.mjs", "poolctl.mjs", "pool-runtime.js", "dashboard.html",
  "patch.mjs", "install.mjs", "package.json", "clone.py",
  "run-pool.sh", "run-pool.ps1", "install.sh", "install.ps1", "README.md"
)
New-Item -ItemType Directory -Force -Path $PoolHome | Out-Null
$PoolHome = (Resolve-Path $PoolHome).Path
$SrcResolved = (Resolve-Path $Src).Path

if ($PoolHome -ne $SrcResolved) {
  foreach ($file in $Files) {
    $from = Join-Path $Src $file
    if (Test-Path $from) { Copy-Item -Force $from (Join-Path $PoolHome $file) }
  }
  if (Test-Path (Join-Path $Src "tests")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $PoolHome "tests") | Out-Null
    Copy-Item -Force (Join-Path $Src "tests\*") (Join-Path $PoolHome "tests")
  }
}

# The pool home holds tokens and device keys, so it stays inside the user
# profile and keeps the default ACLs (only your account and SYSTEM reach it).
# No icacls dance: stripping inheritance is how people lock themselves out.

# ---------------------------------------------------------------- CLI shims
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
"@echo off`r`nnode `"$PoolHome\poolctl.mjs`" %*" | Set-Content -Path (Join-Path $Bin "poolctl.cmd") -Encoding Ascii
@("@echo off",
  "where python >nul 2>nul && (python `"$PoolHome\clone.py`" %* & goto :eof)",
  "py -3 `"$PoolHome\clone.py`" %*") | Set-Content -Path (Join-Path $Bin "fbclone.cmd") -Encoding Ascii

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
if ($userPath -notlike "*$Bin*") {
  [Environment]::SetEnvironmentVariable("Path", ($userPath -replace ";+$", "") + ";$Bin", "User")
  Write-Host "install: added $Bin to your user PATH (open a new terminal to pick it up)"
}

# ---------------------------------------------------------------- app bundle
function Find-AppDir {
  $roots = @()
  foreach ($key in @("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $roots += $value }
  }
  $search = @()
  foreach ($root in $roots) { $search += (Join-Path $root "Programs"); $search += $root }
  foreach ($base in $search) {
    foreach ($name in @("freebuff", "Freebuff", "Freebuff Desktop")) {
      $candidate = Join-Path (Join-Path $base $name) "freebuff.exe"
      if (Test-Path $candidate) { return (Split-Path -Parent $candidate) }
    }
  }
  return ""
}

if (-not $AppDir) { $AppDir = Find-AppDir }
# FREEBUFF_APP_DIR may point at the folder or straight at freebuff.exe.
if ($AppDir -and (Test-Path $AppDir -PathType Leaf)) { $AppDir = Split-Path -Parent $AppDir }
$orchestrator = if ($AppDir) { Join-Path $AppDir "resources\orchestrator\orchestrator.js" } else { "" }

if ($Revert) {
  if (-not $orchestrator -or -not (Test-Path $orchestrator)) { throw "-Revert needs -AppDir <bundle dir>" }
  node (Join-Path $PoolHome "patch.mjs") $orchestrator --revert
} elseif (-not $NoPatch) {
  if ($orchestrator -and (Test-Path $orchestrator)) {
    node (Join-Path $PoolHome "patch.mjs") $orchestrator
  } else {
    Write-Host "install: warning: app bundle not found, skipping the patch."
    Write-Host "  point at it with:  .\install.ps1 -AppDir `"C:\Users\you\AppData\Local\Programs\freebuff`""
  }
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "pool installed"
Write-Host "  home      $PoolHome"
Write-Host "  core      $PoolHome\pool-core.mjs"
Write-Host "  dashboard $PoolHome\dashboard.html"
Write-Host "  cli       poolctl status"
Write-Host "  clones    fbclone list"
Write-Host "  launch    $PoolHome\run-pool.ps1"
if ($AppDir) { Write-Host "  app       $AppDir" } else { Write-Host "  app       (not detected - set FREEBUFF_APP_DIR)" }
Write-Host ""
Write-Host "next:"
Write-Host "  1) seed accounts:   node $PoolHome\poolctl.mjs import `"$env:APPDATA\freebuff-desktop\state.json`""
Write-Host "  2) start pooled:    powershell -ExecutionPolicy Bypass -File `"$PoolHome\run-pool.ps1`""
Write-Host "  3) dashboard:       node $PoolHome\poolctl.mjs open"
