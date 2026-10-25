#!/usr/bin/env node
// Install the pool runtime next to a Freebuff profile and patch the bundle.
// Usage: node install.mjs [--app <squashfs-root>] [--revert]
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const revert = args.includes("--revert");
const appIndex = args.indexOf("--app");
const appDir = resolve(
  appIndex >= 0 && args[appIndex + 1] ? args[appIndex + 1] : join(here, "..", "squashfs-root"),
);
const orchestrator = join(appDir, "resources", "orchestrator", "orchestrator.js");
const home = process.env.FREEBUFF_POOL_HOME || join(homedir(), ".freebuff-pool");

if (!existsSync(orchestrator)) {
  console.error(`no orchestrator bundle at ${orchestrator}`);
  console.error("pass --app <path to extracted squashfs-root>");
  process.exit(1);
}

execFileSync(
  process.execPath,
  [join(here, "patch.mjs"), orchestrator, ...(revert ? ["--revert"] : [])],
  { stdio: "inherit" },
);

if (revert) process.exit(0);

mkdirSync(home, { recursive: true, mode: 0o700 });
for (const file of ["pool-core.mjs", "dashboard.html", "poolctl.mjs"]) {
  const from = join(here, file);
  const to = join(home, file);
  // Running the installer from inside the pool home copies a file onto itself.
  if (resolve(from) !== resolve(to)) copyFileSync(from, to);
}
chmodSync(home, 0o700);
// Directories keep the execute bit (Electron needs it for its SingletonLock); only files tighten,
// and a file that is already executable (install.sh, clone.py, run-pool.sh) keeps it.
for (const entry of readdirSync(home)) {
  const path = join(home, entry);
  const stats = statSync(path);
  chmodSync(path, stats.isDirectory() ? 0o700 : stats.mode & 0o100 ? 0o700 : 0o600);
}
const runLauncher = join(here, "run-pool.sh");
const runTarget = join(home, "run-pool.sh");
if (resolve(runLauncher) !== resolve(runTarget)) copyFileSync(runLauncher, runTarget);
chmodSync(runTarget, 0o700);

const size = statSync(join(home, "pool-core.mjs")).size;
console.log(`
pool installed
  core      ${join(home, "pool-core.mjs")} (${size} bytes)
  dashboard ${join(home, "dashboard.html")}
  cli       node ${join(home, "poolctl.mjs")} status
  launch    ${join(home, "run-pool.sh")}

next:
  1) seed accounts from your current install (optional):
     node ${join(home, "poolctl.mjs")} import ~/.config/freebuff-desktop/state.json
  2) start the pooled copy:
     ${join(home, "run-pool.sh")}
  3) open the dashboard URL printed by: node ${join(home, "poolctl.mjs")} open
`);
