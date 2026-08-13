// The self-improvement loop's judgement, tested without letting it ship.
//
// This loop pushes real code to production unattended. The guards were already
// tested (test/guards.test.mjs). What was not tested is whether it can decide
// sensibly — and it could not:
//
//   --dry refused to run at all on a dirty tree, so a dry pass was impossible
//   on any day Grayson was mid-something, which is the day you want to read one
//
//   --dry ran `git checkout main && git pull` BEFORE the dry branch, so the
//   mode documented as "change nothing" moved your checkout
//
//   it treated `status: running` as a failure, so a request in flight — one
//   Grayson was waiting on — looked like a bug report
//
//   it had no memory of what it had already attempted, so a fixed bug's old run
//   file kept it first in the queue forever. Fixing code does not rewrite
//   history, so the loop could never converge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src/improve.mjs");
const src = await readFile(SRC, "utf8");

test("dry never moves the checkout", () => {
  // The mutation must sit behind `if (!dry)`. A dry run that pulls is not dry.
  const i = src.indexOf("git checkout -q main");
  assert.ok(i > 0, "the checkout line vanished — re-read this test");
  const preceding = src.slice(Math.max(0, i - 400), i);
  assert.match(preceding, /if \(!dry\)/, "the git checkout/pull must be guarded by !dry");
});

test("dry reports instead of refusing", () => {
  // Blockers are collected and returned, not used as an early exit, when dry.
  assert.match(src, /const blockers = \[\]/);
  assert.match(src, /if \(!dry && blockers\.length\) return \{ skipped: blockers\[0\] \}/);
});

test("a live run is not mistaken for a failure", () => {
  // `status: running` alone must not qualify; only age makes it stuck.
  assert.doesNotMatch(src, /status: \(failed\|running\)/,
    "matching `running` treats an in-flight request as a bug report");
  assert.match(src, /\^status: failed\$/);
  assert.match(src, /stuck = age >/);
});

test("every issue carries a stable key", () => {
  // Three kinds are produced: health, run, log. All need a key or the
  // already-attempted filter silently does nothing.
  for (const kind of ["health:", "run:", "log:"]) {
    assert.ok(src.includes("key: `" + kind), `issues of kind ${kind} have no key`);
  }
});

test("attempts are recorded with their key, on every exit path", () => {
  // If a path records no key, that issue is retried forever. The
  // off-limits path used to record nothing at all.
  const pushes = src.match(/state\.history\.push\(\{[^}]*\}\)/g) || [];
  assert.ok(pushes.length >= 5, `expected at least 5 history writes, found ${pushes.length}`);
  for (const p of pushes) {
    assert.match(p, /key: issue\.key/, `a history write has no key: ${p.slice(0, 80)}`);
  }
});

test("already-attempted issues are filtered out", () => {
  assert.match(src, /const attempted = new Set\(\(state\.history \|\| \[\]\)\.map\(\(h\) => h\.key\)/);
  assert.match(src, /found\.filter\(\(i\) => !attempted\.has\(i\.key\)\)/);
});

test("the loop still cannot edit its own brakes", () => {
  // Unchanged, and worth re-asserting next to edits of this file.
  assert.match(src, /OFF_LIMITS = \[.*improve\\\.mjs/s);
  assert.match(src, /\\.env/);
});
