// test/when.test.mjs — stored instants, rendered on the right clock.
//
// The bug this guards against is not a crash. Every one of these strings looked
// perfectly well-formed; they were just four hours off, which is exactly long
// enough to be believed. The job list showed a run at 17:56 while the clock said
// 14:25, and this session read its own panel and scheduled work for after a job
// had "already fired" when its 18:00 was still hours away.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { localStamp, ago } from "../src/when.mjs";

test("the rendered time is the same instant, read on the local clock", () => {
  // The real property, and the one the string-slice version failed: parse the
  // output back AS LOCAL and you must land on the instant you started with.
  // Asserting the digits directly would just restate the implementation.
  for (const iso of [
    "2026-08-13T17:56:00.000Z",
    "2026-01-02T03:04:05.000Z",   // a date whose UTC day differs from local
    "2026-06-30T23:59:00.000Z",
  ]) {
    const back = new Date(localStamp(iso).replace(" ", "T"));
    assert.strictEqual(
      Math.floor(back.getTime() / 60000),
      Math.floor(new Date(iso).getTime() / 60000),
      `${iso} did not round-trip`,
    );
  }
});

test("in a zone with an offset it does not just echo the UTC digits", () => {
  // Pinned to a real zone in a child process so this proves the same thing on a
  // machine set to UTC, where the bug is invisible.
  const script =
    'import("./src/when.mjs").then(m=>{' +
    'const iso="2026-08-13T17:56:00.000Z";' +
    'console.log(JSON.stringify([m.localStamp(iso), iso.slice(0,16).replace("T"," ")]));})';
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, TZ: "America/New_York" },
  }).toString();
  const [local, naive] = JSON.parse(out);
  assert.strictEqual(local, "2026-08-13 13:56", "New York is UTC-4 in August");
  assert.notStrictEqual(local, naive, "this is precisely the old behaviour");
});

test("a date can move a day, not only an hour", () => {
  const out = execFileSync(process.execPath, [
    "-e", 'import("./src/when.mjs").then(m=>console.log(m.localStamp("2026-01-02T03:04:00.000Z")))',
  ], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TZ: "America/New_York" } })
    .toString().trim();
  // 03:04 UTC on the 2nd is 22:04 on the 1st in New York. A brief filed under
  // the wrong day is worse than one filed at the wrong hour.
  assert.strictEqual(out, "2026-01-01 22:04");
});

test("nothing unparseable becomes a confident wrong answer", () => {
  // These land in a model prompt. "NaN-NaN-NaN" is obvious; a plausible wrong
  // date is not, so bad input comes back untouched.
  assert.strictEqual(localStamp(""), "");
  assert.strictEqual(localStamp(null), "");
  assert.strictEqual(localStamp(undefined), "");
  assert.strictEqual(localStamp("not a date"), "not a date");
  assert.ok(!localStamp("not a date").includes("NaN"));
});

test("seconds are opt-in", () => {
  assert.match(localStamp("2026-08-13T17:56:07.000Z"), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.match(localStamp("2026-08-13T17:56:07.000Z", { seconds: true }), /\d\d:\d\d:\d\d$/);
});

test("ago() names the distance, and says so when a stamp is in the future", () => {
  const now = new Date("2026-08-13T18:00:00.000Z").getTime();
  const at = (mins) => new Date(now - mins * 60000).toISOString();
  assert.strictEqual(ago(at(0), now), "just now");
  assert.strictEqual(ago(at(1), now), "1 minute ago");
  assert.strictEqual(ago(at(45), now), "45 minutes ago");
  assert.strictEqual(ago(at(60), now), "1 hour ago");
  assert.strictEqual(ago(at(60 * 30), now), "1 day ago");
  // Not cosmetic: a future stamp means clock skew or a bad write, and rounding
  // it to "just now" hides the only evidence.
  assert.strictEqual(ago(at(-90), now), "in the future");
  assert.strictEqual(ago("rubbish", now), "");
});

test("no human-facing render slices an ISO string any more", () => {
  // The pattern that caused this, so it cannot quietly come back.
  const roots = ["src", "src/tools", "bin"];
  const offenders = [];
  for (const dir of roots) {
    for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      if (!f.endsWith(".mjs")) continue;
      const body = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8")
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      if (/replace\(\s*"T"\s*,\s*" "\s*\)/.test(body)) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepStrictEqual(offenders, [], "these render UTC as if it were local time");
});
