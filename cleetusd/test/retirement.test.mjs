// test/retirement.test.mjs — when a retired issue becomes work again.
//
// Attempts are retired permanently, which is what makes the loop converge: a run
// file that recorded a failure keeps that record forever, so without retirement
// the same dead bug stays top-ranked every day and eats all three daily cycles.
//
// The cost is blindness. If outlook is fixed by hand and later breaks again for
// a real reason in the code, the loop can never look at it. Two conditions
// separate a regression from the same old failure:
//
//   RECOVERED — it was green at some point after the attempt
//   COOLDOWN  — that attempt was long enough ago
//
// The cooldown is not padding. `brief` is green all day and red every night, so
// "has it been green since the attempt?" is true EVERY MORNING. Without a
// cooldown that check returns to the work list daily and the waste comes back.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function recoveredSinceWith(logLines, name, sinceIso) {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  writeFileSync(join(home, "Library", "Logs", "cleetus-health.log"), logLines.join("\n") + "\n");
  const src = join(process.cwd(), "src", "improve.mjs");
  const script =
    `const fs = await import("node:fs/promises");` +
    `const path = await import("node:path");` +
    `const { CONFIG } = await import(${JSON.stringify("file://" + join(process.cwd(), "src", "config.mjs"))});` +
    `const text = await fs.readFile(${JSON.stringify(src)}, "utf8");` +
    `const body = text.slice(text.indexOf("async function recoveredSince("), text.indexOf("async function findWork"));` +
    `const fn = new Function("readFile","join","CONFIG", body + "; return recoveredSince;")(fs.readFile, path.join, CONFIG);` +
    `process.stdout.write(JSON.stringify(await fn(${JSON.stringify(name)}, ${JSON.stringify(sinceIso)})));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  rmSync(home, { recursive: true, force: true });
  return JSON.parse(out);
}

const at = (iso, fails) => `${iso}  41/43 ok  FAIL: macOS-is-not-refusing-him-anything${fails ? ` integrations-healthy[${fails}]` : ""}`;

test("a check that went green after the attempt counts as recovered", () => {
  const got = recoveredSinceWith([
    at("2026-08-10T00:00:00.000Z", "outlook"),
    at("2026-08-11T00:00:00.000Z", ""),          // green
    at("2026-08-12T00:00:00.000Z", "outlook"),
  ], "outlook", "2026-08-10T12:00:00.000Z");
  assert.strictEqual(got, true);
});

test("a check that never recovered stays retired", () => {
  // outlook and push, both waiting on a human. Re-offering them every cycle is
  // the waste retirement exists to prevent.
  const got = recoveredSinceWith([
    at("2026-08-11T00:00:00.000Z", "outlook,push"),
    at("2026-08-12T00:00:00.000Z", "outlook,push"),
  ], "outlook", "2026-08-10T12:00:00.000Z");
  assert.strictEqual(got, false);
});

test("readings BEFORE the attempt do not count as recovery", () => {
  // Otherwise every issue looks recovered, because everything was green once.
  const got = recoveredSinceWith([
    at("2026-08-01T00:00:00.000Z", ""),          // green, but long before
    at("2026-08-12T00:00:00.000Z", "outlook"),
  ], "outlook", "2026-08-10T12:00:00.000Z");
  assert.strictEqual(got, false);
});

test("no health log means no evidence of recovery", () => {
  // The opposite default to previouslyDown(). There, not knowing must not
  // suppress work; here, not knowing must not RESURRECT it — the safe direction
  // is different because the consequence is.
  assert.strictEqual(recoveredSinceWith([], "outlook", "2026-08-10T12:00:00.000Z"), false);
});

test("the cooldown exists and is long enough to outlast a daily cycle", () => {
  const src = readFileSync(new URL("../src/improve.mjs", import.meta.url), "utf8");
  const m = src.match(/CLEETUSD_RETRY_DAYS \|\| (\d+)/);
  assert.ok(m, "there must be a cooldown");
  assert.ok(Number(m[1]) > 1, `${m[1]} day(s) does not outlast a check that recovers every morning`);
  assert.match(src, /oldEnough && await recoveredSince/, "both conditions must be required");
});
