#!/usr/bin/env node
// Inject (or refresh) the pool runtime inside a Freebuff orchestrator bundle.
// Usage: node patch.mjs <orchestrator.js> [--revert] [--check-only]
//
// Fresh bundle   → inject the runtime before `var server = Bun.serve({`.
// Patched bundle → replace the injected block in place when the runtime on disk
//                  changed (no revert needed), otherwise report the version.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(here, "pool-runtime.js");
const MARKER_RE = /\/\* __FREEBUFF_POOL_RUNTIME__ v(\d+) \*\//;
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
const marker = MARKER_RE.exec(source);
const patched = marker !== null;

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
  console.log(patched ? `patched (v${marker[1]})` : "clean");
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

function readRuntime() {
  const text = readFileSync(RUNTIME, "utf8");
  const version = MARKER_RE.exec(text);
  if (!version || !text.includes("__FREEBUFF_POOL_RUNTIME__")) {
    console.error(`runtime snippet lost its marker: ${RUNTIME}`);
    process.exit(1);
  }
  return { text, version: version[1] };
}

const runtime = readRuntime();

// ── already patched: swap the injected block when the runtime changed ──────
if (patched) {
  const start = marker.index;
  const anchorAt = source.indexOf(ANCHOR, start);
  if (anchorAt < 0) {
    console.error(`the patched bundle no longer contains its anchor (${ANCHOR})`);
    console.error("rebuild from a clean bundle with --revert, then patch again");
    process.exit(1);
  }
  const injected = source.slice(start, anchorAt);
  if (injected === `${runtime.text}\n`) {
    console.log(`already patched (v${marker[1]})`);
    process.exit(0);
  }
  const next = `${source.slice(0, start)}${runtime.text}\n${source.slice(anchorAt)}`;
  try {
    syntaxCheck(next);
  } catch (error) {
    console.error("updated bundle does not parse; nothing written");
    console.error(String(error.stderr ?? error.message).slice(0, 2000));
    process.exit(1);
  }
  writeFileSync(target, next);
  console.log(
    `updated runtime v${marker[1]} → v${runtime.version} (${next.length - source.length >= 0 ? "+" : ""}${next.length - source.length} bytes)`,
  );
  process.exit(0);
}

// ── clean bundle: inject before the anchor ─────────────────────────────────
const occurrences = source.split(ANCHOR).length - 1;
if (occurrences !== 1) {
  console.error(`anchor is not unique (${occurrences} occurrences): ${ANCHOR}`);
  process.exit(1);
}

const insertAt = source.indexOf(ANCHOR);
const next = `${source.slice(0, insertAt)}${runtime.text}\n${source.slice(insertAt)}`;

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
console.log(`patched ${target} (v${runtime.version}, +${next.length - source.length} bytes)`);
