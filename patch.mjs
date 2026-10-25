#!/usr/bin/env node
// Inject the pool runtime into a Freebuff orchestrator bundle.
// Usage: node patch.mjs <orchestrator.js> [--revert] [--check-only]
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(here, "pool-runtime.js");
const MARKER = "/* __FREEBUFF_POOL_RUNTIME__ v1 */";
const ANCHOR = "var server = Bun.serve({";

const args = process.argv.slice(2);
const target = resolve(args.find((a) => !a.startsWith("--")) ?? "");
const revert = args.includes("--revert");
const checkOnly = args.includes("--check-only");

if (!target || !existsSync(target)) {
  console.error("usage: node patch.mjs <orchestrator.js> [--revert] [--check-only]");
  process.exit(2);
}

const backup = `${target}.pool-orig`;
const source = readFileSync(target, "utf8");
const patched = source.includes(MARKER);

if (revert) {
  if (!existsSync(backup)) {
    console.error(`nothing to revert: ${backup} is missing`);
    process.exit(1);
  }
  if (patched) copyFileSync(backup, target);
  console.log(`reverted ${target}`);
  process.exit(0);
}

if (checkOnly) {
  console.log(patched ? "patched" : "clean");
  process.exit(patched ? 0 : 1);
}

function syntaxCheck(text) {
  const dir = mkdtempSync(join(tmpdir(), "fb-pool-check-"));
  const file = join(dir, "bundle.mjs");
  try {
    writeFileSync(file, text);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (patched) {
  console.log("already patched");
  process.exit(0);
}

const occurrences = source.split(ANCHOR).length - 1;
if (occurrences !== 1) {
  console.error(`anchor is not unique (${occurrences} occurrences): ${ANCHOR}`);
  process.exit(1);
}

const runtime = readFileSync(RUNTIME, "utf8");
if (!runtime.includes("__FREEBUFF_POOL_RUNTIME__")) {
  console.error(`runtime snippet lost its marker: ${RUNTIME}`);
  process.exit(1);
}

const insertAt = source.indexOf(ANCHOR);
const next = `${source.slice(0, insertAt)}${runtime}\n${source.slice(insertAt)}`;

try {
  syntaxCheck(next);
} catch (error) {
  console.error("patched bundle does not parse; nothing written");
  console.error(String(error.stderr ?? error.message).slice(0, 2000));
  process.exit(1);
}

if (!existsSync(backup)) {
  copyFileSync(target, backup);
  console.log(`backup ${backup}`);
}
writeFileSync(target, next);
console.log(`patched ${target} (+${next.length - source.length} bytes)`);
