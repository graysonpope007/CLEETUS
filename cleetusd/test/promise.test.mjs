// test/promise.test.mjs — an answer that stops on a promise is not an answer.
//
// This detector marks half-answers so the user sees they were cut off, and so
// looksFailed() hands them to the teacher. It was written around one observed
// example — "Let me check the Cleetus V2 project:" — and the pattern it grew
// required NO sentence-ending punctuation: `[^.!?]*:?\s*$`.
//
// So it caught a promise ending in a colon and missed every promise ending in a
// full stop, which is the more common form. The improve loop's first live cycle
// produced exactly that: twenty tool calls, all the right files read, then "Let
// me read the health.js file to understand how it checks the outlook status."
// The answer went back unmarked, the run was recorded as fine, and the loop
// reported "no change made" rather than a failure anyone would look at.

import { test } from "node:test";
import assert from "node:assert";
import { endsOnAPromise } from "../src/agent.mjs";

test("a promise ending in a full stop is caught", () => {
  // The case that got through. Verbatim from the run file.
  assert.strictEqual(
    endsOnAPromise("Let me read the health.js file to understand how it checks the outlook status."), true);
  assert.strictEqual(endsOnAPromise("I will look at the config now."), true);
  assert.strictEqual(endsOnAPromise("I'll check the other repo."), true);
  assert.strictEqual(endsOnAPromise("Next, I'll compare it against main."), true);
});

test("a filename's dot does not hide the promise", () => {
  // The actual root cause, and the reason this went unnoticed: the old pattern
  // spanned the sentence with [^.!?]*, which stops dead at the dot in a
  // filename. In a coding agent most promises name a file, so most of them
  // slipped through — the colon example it was built around had no filename in
  // it, which is why it looked like it worked.
  for (const t of [
    "Let me read the health.js file to understand how it checks the outlook status.",
    "I'll open src/agent.mjs and see what route() does.",
    "Let me look at package.json first.",
  ]) assert.strictEqual(endsOnAPromise(t), true, t);
});

test("the original colon form still works", () => {
  assert.strictEqual(endsOnAPromise("Let me check the Cleetus V2 project:"), true);
  assert.strictEqual(endsOnAPromise("Checking the health endpoint:"), true);
});

test("a curly apostrophe is still an apostrophe", () => {
  assert.strictEqual(endsOnAPromise("I’ll take a look at that file."), true);
});

test("'let me know' is a sign-off, not a promise", () => {
  // The politest ending in the language. Flagging it would mark complete
  // answers as truncated, and a marker on a finished answer is worse than none.
  assert.strictEqual(endsOnAPromise("Let me know if you want the other half too."), false);
  assert.strictEqual(endsOnAPromise("It is fixed and deployed. Let me know if anything else breaks."), false);
});

test("a real answer is not flagged", () => {
  for (const t of [
    "The outlook token expired; I refreshed it and health is green again.",
    "Nothing is wrong with it — it answered in 0.19 seconds, five times.",
    "I checked all four dossiers and only wardrobe.md is empty.",
    "",
  ]) assert.strictEqual(endsOnAPromise(t), false, t);
});

test("a promise buried mid-answer is not the same as ending on one", () => {
  // Only the TAIL matters. "Let me check" followed by the actual finding is a
  // complete answer that happens to narrate itself.
  assert.strictEqual(
    endsOnAPromise("Let me check the health endpoint. It returns 200 and outlook is the only failure."),
    false);
});

test("looksFailed still routes these to the teacher", () => {
  // The detector exists to feed this. If the wiring is cut, the half-answers
  // stop being learned from and nothing looks different.
  const src = require_src();
  assert.match(src, /if \(endsOnAPromise\(answer\)\) return true;/);
});

function require_src() {
  return readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
}
import { readFileSync } from "node:fs";
