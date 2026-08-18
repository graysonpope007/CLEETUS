// test/improvebaseline.test.mjs — when the loop is allowed to work.
//
// The loop refused to run whenever cloud health was red, saying it "cannot tell
// my damage from existing damage". regressed() in the same file does precisely
// that: it diffs the set of failing names and counts only new ones.
//
// The contradiction was total rather than cosmetic. Every health candidate has
// the form "X is down", so a red baseline is implied by having health work at
// all — the loop could only run when it had nothing of that kind to fix. Four
// scheduled runs, four skips, no cycle ever completed.
//
// What it genuinely cannot do is work through a baseline it could not MEASURE:
// if the site is unreachable, "after" is unreachable too, the diff is empty, and
// real damage reads as clean.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/improve.mjs", import.meta.url), "utf8");

// regressed() is the thing the guard claimed was impossible. Lift it out and
// run it, rather than trusting the comment above it.
const body = src.slice(src.indexOf("function regressed"), src.indexOf("// ── Finding something genuinely wrong"));
const regressed = new Function(`${body}; return regressed;`)();

test("damage is detectable even when the baseline is already red", () => {
  const before = { ok: false, down: ["outlook", "push"] };
  // Same failures after: the change broke nothing new.
  assert.strictEqual(regressed(before, { ok: false, down: ["outlook", "push"] }), null);
  // A new name appears: that is damage, and it is named.
  assert.match(regressed(before, { ok: false, down: ["outlook", "push", "plaid"] }), /plaid/);
  // Fixing one of them is not damage.
  assert.strictEqual(regressed(before, { ok: false, down: ["push"] }), null);
});

test("a pre-existing failure is never blamed on the change", () => {
  const before = { ok: false, down: ["outlook"] };
  assert.strictEqual(regressed(before, { ok: false, down: ["outlook"] }), null);
});

test("going red from a green baseline is still damage", () => {
  assert.match(regressed({ ok: true, down: [] }, { ok: false, down: ["plaid"] }), /red|plaid/);
});

test("the guard now turns on measurability, not on colour", () => {
  // The specific regression to prevent: someone reinstating "if red, stop"
  // silently returns the loop to never running.
  const guard = src.slice(src.indexOf("const unmeasurable"), src.indexOf("const found = await findWork"));
  assert.match(guard, /unreachable/, "the refusal must key off unreachability");
  assert.ok(
    !/if \(!before\.ok && !dry\) return \{ skipped/.test(src),
    "the old colour-based refusal is back — the loop will never run again",
  );
  // And a red-but-measurable baseline must still be reported, not hidden.
  assert.match(guard, /only NEW failures count as damage/);
});

test("an unreachable cloud is still an absolute refusal", () => {
  // The one case that must never be worked through. cloudHealth() maps a failed
  // fetch to down:["unreachable"], and the guard keys off exactly that name — so
  // if either side is renamed without the other, the loop would start committing
  // against a site it cannot measure. Both halves are asserted here.
  assert.match(
    src.slice(src.indexOf("async function cloudHealth"), src.indexOf("/** Strictly worse")),
    /down: \["unreachable"\]/,
    "cloudHealth no longer reports unreachability under that name",
  );

  const classify = (before) => !before.ok && (before.down || []).includes("unreachable");
  assert.strictEqual(classify({ ok: false, down: ["unreachable"] }), true);
  assert.strictEqual(classify({ ok: false, down: ["outlook", "push"] }), false);
  assert.strictEqual(classify({ ok: true, down: [] }), false);

  // ...and the refusal it drives is a real return, not just a logged blocker.
  const guard = src.slice(src.indexOf("const unmeasurable"), src.indexOf("const found = await findWork"));
  assert.match(guard, /if \(unmeasurable && !dry\) \{[\s\S]*return \{ skipped/);
});

test("the checkout is moved to main before health is consulted", () => {
  // Not a defect to fix here, but worth pinning: in a non-dry run the repo is
  // moved to main and pulled BEFORE cloudHealth() is called, so a run that then
  // refuses has still changed the checkout. Anyone reasoning about "it refused,
  // so it did nothing" needs to know that is not quite true.
  const pull = src.indexOf('git checkout -q main');
  const health = src.indexOf("const before = await cloudHealth()");
  assert.ok(pull > 0 && health > pull, "ordering changed — revisit the comment in this test");
});

test("the builder is forbidden from weakening a check to make it pass", () => {
  // The cheapest fix for a failing check is to stop it checking. That route has
  // to be closed explicitly because the revert cannot catch it: weakening an
  // assertion turns health GREEN, so nothing is newly failing and the change
  // stands forever. It is the one failure mode the whole safety design misses.
  assert.match(src, /NEVER make a check pass by weakening what it asserts/);
  assert.match(src, /Fix the thing being measured, not the measurement/);
});

test("the builder is told some checks are red for good reasons", () => {
  // `brief` is red from midnight until the morning brief is written — about
  // seven hours a night, every night, by design. Evidence from the health log:
  // it went green all day and flipped at 00:07, the first check after local
  // midnight. Without this, the loop treats a correct check as a defect.
  assert.match(src, /RED FOR A GOOD REASON at some times of day/);
  assert.match(src, /change NOTHING and say which/);
});

test("the builder is told some failures have no cause in the code", () => {
  // Written while four checks were red from one database outage and an expired
  // OAuth token. Neither has a fix in this repository, and the loop gets three
  // cycles a day — spent on those, it does nothing else all day.
  //
  // The sharper risk: a model told to fix something with no code-level cause
  // will find SOMETHING to change, and that change is unrelated by construction.
  assert.match(src, /Some failures have NO CAUSE IN THIS CODE/);
  assert.match(src, /db_error/, "the actual signatures seen in the outage should be named");
  assert.match(src, /needsAuth/);
});

test("it forbids dressing up a broken dependency", () => {
  // A retry around a database that is refusing reads, or a friendlier error
  // message, makes the check pass while nothing is fixed — the masking failure
  // in a form that looks like diligence rather than laziness.
  assert.match(src, /Do not add a retry, a fallback, or a/);
  assert.match(src, /Diagnosing\\n?.*something you cannot fix IS the useful answer|Diagnosing/);
});

test("diagnosis is offered as a complete answer, not a failure", () => {
  // Otherwise the loop treats "I could not fix it" as its own failure and
  // reaches for a change to justify the cycle.
  assert.match(src, /change NOTHING\. Say what the underlying cause is/);
});
