// test/money.test.mjs — the morning brief must not name dollar amounts.
//
// The prompt has said "Money in percentages, never dollar figures" since the job
// was written. The first run anyone actually read said "checking has roughly $5K
// across accounts". The instruction was obeyed for the position sizes in the
// same sentence and dropped for the cash, which is what makes this worth a guard
// rather than a stronger sentence in the prompt: the model is not ignoring the
// rule, it is applying it unevenly, and that is exactly the failure a test
// catches and a reread does not.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

// Read the pattern out of the source rather than restating it, so the test
// cannot drift into passing against its own private copy of the regex.
const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
const line = src.match(/^const MONEY = (\/.+\/g);$/m);
assert.ok(line, "could not find the MONEY pattern in src/jobs.mjs");
const make = () => new RegExp(line[1].slice(1, -2), "g");
const leaked = (s) => String(s).match(make()) || [];

test("it catches the amounts a model actually writes", () => {
  for (const [text, want] of [
    ["checking has roughly $5K across accounts after expenses", ["$5K"]],
    ["you owe $1,200 on the books", ["$1,200"]],
    ["coffee was $4.75", ["$4.75"]],
    ["the account is near $3 million", ["$3 million"]],
    ["$5K in checking and $1,200 out", ["$5K", "$1,200"]],
  ]) assert.deepStrictEqual(leaked(text), want, text);
});

test("it leaves alone the things that are not amounts", () => {
  // A brief naming a ticker is fine and happens often; percentages are the
  // whole point of the rule. Flagging these would make the guard fire on
  // correct briefs, and a guard that cries wolf gets deleted.
  for (const text of [
    "should I sell my $SPY position",
    "NVDA is 47% of the account, up 3.2%",
    "the $ sign alone",
  ]) assert.deepStrictEqual(leaked(text), [], text);
});

test("redaction does not eat the following word", () => {
  // "$1,200 out" -> "[amount]out" if the space is inside the match. This is the
  // shape the pattern had on the first attempt.
  assert.strictEqual(
    "$5K in checking and $1,200 out".replace(make(), "[amount]"),
    "[amount] in checking and [amount] out",
  );
});

test("asking twice gives the same answer", () => {
  // A /g regex carries lastIndex between .test() calls, so a shared pattern
  // answers true then false and the guard misses every other brief. Nothing
  // here may use .test() on the shared object.
  const once = leaked("checking has roughly $5K");
  const twice = leaked("checking has roughly $5K");
  assert.deepStrictEqual(once, twice);
  assert.ok(!/\.test\(/.test(src.split("const MONEY")[1].slice(0, 400)), "MONEY must not be used with .test()");
});

// ---------------------------------------------------------------------------
// The retry-and-redact branch. This only executes when the model disobeys, so
// on a compliant day the whole guard is dead code that has never run. Driving
// it with a fake `retry` is the only way to know it works before the morning it
// matters.

import { scrubMoney } from "../src/jobs.mjs";

const DIRTY = "checking has roughly $5K across accounts";

test("a clean first answer is passed straight through, no retry", async () => {
  let asked = 0;
  const r = await scrubMoney("NVDA is 47% of the account", () => { asked++; return "x"; });
  assert.strictEqual(r.text, "NVDA is 47% of the account");
  assert.strictEqual(r.redacted, 0);
  assert.strictEqual(asked, 0, "must not spend a second model call on a clean brief");
});

test("a clean retry replaces the leaking answer, with nothing redacted", async () => {
  const r = await scrubMoney(DIRTY, () => "checking is a small share of the total");
  assert.strictEqual(r.text, "checking is a small share of the total");
  assert.strictEqual(r.redacted, 0);
});

test("the retry is told what it did wrong", async () => {
  // Quoting the offending text back is the difference between "try again" and
  // a correction the model can act on.
  let told = null;
  await scrubMoney(DIRTY, (leaks) => { told = leaks; return "clean"; });
  assert.deepStrictEqual(told, ["$5K"]);
});

test("a still-leaking retry is redacted and counted", async () => {
  const r = await scrubMoney(DIRTY, () => "checking holds $5K, about 4% of it");
  assert.match(r.text, /\[amount\]/);
  assert.deepStrictEqual(leakedMoneyOf(r.text), [], "nothing may survive redaction");
  assert.strictEqual(r.redacted, 1, "the count is what makes the redaction visible in the summary");
});

test("an empty or worse retry does not replace a better first answer", async () => {
  // A second attempt is not automatically the good one. Returning nothing must
  // not blank the brief.
  for (const bad of ["", "   ", "$5K and $1,200 and $47.50"]) {
    const r = await scrubMoney(DIRTY, () => bad);
    assert.match(r.text, /checking has roughly \[amount\] across accounts/);
    assert.strictEqual(r.redacted, 1);
  }
});

test("a retry that leaks less is preferred, then redacted", async () => {
  const two = "we hold $5K in checking and $1,200 in savings";
  const r = await scrubMoney(two, () => "we hold $900 total");
  assert.strictEqual(r.text, "we hold [amount] total");
  assert.strictEqual(r.redacted, 1);
});

function leakedMoneyOf(s) { return String(s).match(make()) || []; }
