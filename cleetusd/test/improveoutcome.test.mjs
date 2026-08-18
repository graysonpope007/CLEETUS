// test/improveoutcome.test.mjs — the two sentences the improve loop tells about itself.
//
// Both were misleading in the same direction: they made an idle, unsuccessful
// loop read as a converged, successful one. Neither was a bug in what the loop
// DID — the code was right and the words were wrong, which is the harder kind
// to notice, because everything keeps working while the record of it rots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { idleSummary, shipOutcome } from "../src/improve.mjs";

test("shipping something that did not fix the issue does not get called a fix", () => {
  // 3909977: improved a message, push stayed exactly as down as before.
  assert.equal(shipOutcome("push", true), "shipped, but push is still failing");
  // 5ab77bb: genuinely fixed the brief check.
  assert.equal(shipOutcome("brief", false), "shipped");
});

test("the outcome names the check, so the record is readable without the diff", () => {
  assert.match(shipOutcome("outlook", true), /outlook/);
});

test("nothing found means nothing is wrong, and says so plainly", () => {
  assert.equal(idleSummary([]), "nothing is wrong");
});

test("live health failures are named, because those are genuinely still broken", () => {
  const s = idleSummary([{ key: "health:outlook" }, { key: "health:push" }]);
  assert.match(s, /2 checks are still failing/);
  assert.match(s, /outlook, push/);
  assert.doesNotMatch(s, /log\/run/, "there were no stale records to mention");
});

test("old log lines are NOT described as still failing", () => {
  // This is the assertion that matters. cleetusd.err.log keeps the
  // ERR_HTTP_HEADERS_SENT lines forever — that bug was fixed and verified on
  // 13 Aug — so they are re-found on every pass and can never clear. The first
  // version of this message called them "still failing", which was a confident
  // wrong sentence about the state of the machine.
  const s = idleSummary([
    { key: "health:push" },
    { key: "log:Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers" },
    { key: "run:2026-08-01-1200-something.md" },
  ]);
  assert.match(s, /1 check is still failing and already attempted: push/);
  assert.match(s, /2 older log\/run records that cannot clear on their own/);
  assert.doesNotMatch(s, /3 checks/, "log and run records must not be counted as failing checks");
});

test("all-stale reads as no live failure rather than as silence", () => {
  const s = idleSummary([{ key: "log:whatever" }]);
  assert.match(s, /no live check is failing/);
  assert.match(s, /1 older log\/run record that cannot clear/);
  assert.doesNotMatch(s, /records that/, "singular record takes a singular verb");
});

test("the summary never claims convergence", () => {
  // The sentence it replaced was "nothing new — all 4 known issues have been
  // attempted", which describes the loop's own bookkeeping and reads like the
  // work is done. Whatever this says, it must not say that.
  const s = idleSummary([{ key: "health:push" }, { key: "log:x" }]);
  assert.doesNotMatch(s, /nothing new/);
  assert.doesNotMatch(s, /^all /);
  assert.match(s, /still failing/);
});
