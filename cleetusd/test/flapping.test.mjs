// test/flapping.test.mjs — a single reading is not an outage.
//
// The improve loop reads one health snapshot, so a flap and an outage look
// identical. Measured over 64 readings of the real log:
//
//   outlook   down in 59 readings, 0 isolated blips
//   push      down in 59 readings, 0 isolated blips
//   plaid     down in 16 readings, 7 isolated blips   ← 44% of its failures
//
// And `google` appeared in a failure list and was gone half an hour later,
// reporting "connected, 20 events". Acting on one of those spends a whole cycle
// — and one of three daily slots — writing a fix for something that was never
// broken, against a symptom that cannot be reproduced.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// previouslyDown() reads CONFIG.home, and os.homedir() honours $HOME.
function previouslyDownWith(logLines) {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  if (logLines !== null) {
    writeFileSync(join(home, "Library", "Logs", "cleetus-health.log"), logLines.join("\n") + "\n");
  }
  const src = join(process.cwd(), "src", "improve.mjs");
  const script =
    `const fs = await import("node:fs/promises");` +
    `const path = await import("node:path");` +
    `const { CONFIG } = await import(${JSON.stringify("file://" + join(process.cwd(), "src", "config.mjs"))});` +
    // Lift the function out of the source rather than reimplementing it.
    `const text = await fs.readFile(${JSON.stringify(src)}, "utf8");` +
    `const body = text.slice(text.indexOf("async function previouslyDown()"), text.indexOf("async function findWork"));` +
    `const fn = new Function("readFile","join","CONFIG", body + "; return previouslyDown;")(fs.readFile, path.join, CONFIG);` +
    `const out = await fn();` +
    `process.stdout.write(JSON.stringify(out ? [...out] : null));`;
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  rmSync(home, { recursive: true, force: true });
  return JSON.parse(raw);
}

const line = (fails) => `2026-08-14T03:00:00.000Z  41/43 ok  FAIL: macOS-is-not-refusing-him-anything integrations-healthy[${fails}]`;

test("it reads the integrations from the most recent reading", () => {
  const got = previouslyDownWith([line("plaid,outlook,push"), line("outlook,push,brief")]);
  assert.deepStrictEqual(got.sort(), ["brief", "outlook", "push"]);
});

test("a flap present only in the newest reading is not in the previous set", () => {
  // The whole point: plaid down NOW but absent from the reading before means
  // the loop must not treat it as work.
  const previous = previouslyDownWith([line("outlook,push"), line("outlook,push")]);
  assert.ok(!previous.includes("plaid"), "plaid should not appear in the previous reading");
  assert.ok(previous.includes("outlook") && previous.includes("push"));
});

test("no log at all returns null, which must NOT suppress work", () => {
  // Not knowing is a reason to proceed. Returning an empty set instead would
  // silently drop every issue and the loop would go permanently idle.
  assert.strictEqual(previouslyDownWith(null), null);
  assert.strictEqual(previouslyDownWith([]), null);
});

test("a log with no integrations line returns null", () => {
  assert.strictEqual(previouslyDownWith(["2026-08-14T03:00:00.000Z  43/43 ok"]), null);
});

test("the filter proceeds when the previous reading is unknown", () => {
  const src = execFileSync("/bin/cat", ["src/improve.mjs"], { encoding: "utf8" });
  assert.match(src, /if \(alsoDownBefore && !alsoDownBefore\.has\(name\)\)/,
    "the null case must fall through to including the issue");
  assert.match(src, /skipping \$\{name\}: down in this reading only/);
});
