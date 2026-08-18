// test/runawaylog.test.mjs — the failure that defines this project's history.
//
// com.cleetus.chat respawned 423,179 times against a missing script and wrote a
// 113 MB error log doing it. NOTHING SURFACED IT FOR THREE MONTHS. That incident
// is quoted at the top of jobs.mjs as the reason the job runner exists.
//
// There was no check for it. The lesson had been written down and never wired to
// anything, which is its own version of the same bug.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
const block = src.slice(src.indexOf("no log is running away") - 1400, src.indexOf("// ── the front door"));

test("the threshold is above normal and below catastrophic", () => {
  const m = block.match(/CLEETUSD_MAX_LOG_MB \|\| (\d+)/);
  assert.ok(m, "there must be a threshold");
  const mb = Number(m[1]);
  // ollama's stderr is legitimately ~10MB and grows all day; the incident was
  // 113MB. A limit inside that gap catches the real thing without crying wolf.
  assert.ok(mb > 15, `${mb}MB would fire on ollama's ordinary stderr`);
  assert.ok(mb < 113, `${mb}MB would not have caught the 113MB log`);
});

test("it names the offending file, not just a total", () => {
  // "logs are large" is not actionable. Which one, and how big, is.
  assert.match(block, /big\.map\(\(x\) => `\$\{x\.f\} \$\{x\.mb\.toFixed\(0\)\}MB`\)/);
  assert.match(block, /a job may be respawning/);
});

test("the healthy case still reports the largest", () => {
  // A check that says only "ok" hides the trend. Seeing 9.7MB today and 40MB
  // next month is the early warning the original incident never had.
  assert.match(block, /largest \$\{sized\[0\]\.f\}/);
});

test("the fix line says what a giant log actually is", () => {
  assert.match(block, /one error repeating, not one big error/);
});

test("no logs at all is not a failure", () => {
  // A fresh machine has none, and reporting that as a fault would be noise on
  // day one.
  assert.match(block, /"no logs yet"/);
});
