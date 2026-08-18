// test/stepbudget.test.mjs — a budget that fits the task.
//
// The improve loop's first live cycle spent all twenty steps reading — the right
// files, in the right order — and hit the ceiling before it edited anything. It
// then recorded "no change made", which is the same phrase used when the loop
// looks at a problem and decides nothing needs changing. Those are opposite
// outcomes wearing the same label.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const agent = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
const improve = readFileSync(new URL("../src/improve.mjs", import.meta.url), "utf8");

test("the step budget is a parameter, not a constant", () => {
  assert.match(agent, /export async function ask\(\{[^}]*maxSteps = CONFIG\.maxSteps[^}]*\}\)/,
    "ask() must accept a budget");
  assert.match(agent, /for \(let step = 0; step < maxSteps; step\+\+\)/,
    "and the loop must use the parameter, not the constant");
  assert.doesNotMatch(agent, /step < CONFIG\.maxSteps/,
    "the hard-coded ceiling is back, so the caller's budget is ignored");
});

test("conversations keep the old ceiling by default", () => {
  // The default has to stay CONFIG.maxSteps. Raising it for everything would
  // make ordinary chat slower and more expensive to fix one caller's problem.
  assert.match(agent, /maxSteps = CONFIG\.maxSteps/);
});

test("the improve loop asks for more room than a conversation", () => {
  const m = improve.match(/maxSteps: Number\(process\.env\.CLEETUSD_IMPROVE_STEPS \|\| (\d+)\)/);
  assert.ok(m, "the builder call must set its own budget");
  assert.ok(Number(m[1]) > 20, `${m[1]} is not more than the conversational ceiling`);
});

test("running out of room is not filed as 'nothing needed doing'", () => {
  // The distinction that was missing. Both are zero commits; only one is a
  // failure, and only one should prompt anyone to look.
  assert.match(improve, /const ranOut = endsOnAPromise\(result\.answer \|\| ""\);/);
  assert.match(improve, /gave up mid-repair/);
  assert.doesNotMatch(improve, /outcome: "no change made", issue: issue\.what, said: result\.answer \};[\s\S]{0,40}$/,
    "the unconditional outcome should be gone");
});

test("what it said is kept in the history, not just the outcome", () => {
  // Reading `said` is how the ceiling was found at all. An outcome with no
  // evidence attached cannot be second-guessed later.
  assert.match(improve, /said: \(result\.answer \|\| ""\)\.slice\(0, 200\)/);
});

test("hitting the ceiling is marked on the FACT, not on the prose", () => {
  // The salvage marker used to fire only when endsOnAPromise() matched, which
  // recognises one shape of truncation. Asked to list a directory and summarise
  // every file on a budget of two, the salvage returned a tidy, confident list
  // of filenames — no promise, no marker — while the summarising, most of the
  // request, never happened.
  //
  // Whether the loop stopped early is something it already knows for certain.
  // Verified live: with maxSteps 2 the answer now carries "[Answered from
  // partial information: all 2 tool calls were used…]", and an ordinary
  // completed answer ("what is 2+2") carries no marker at all.
  assert.match(agent, /if \(finalText\) \{[\s\S]{0,400}?Answered from partial information/,
    "an exhausted run must be marked whatever the sentence looks like");
  assert.match(agent, /endsOnAPromise\(finalText\)\s*\?/,
    "the two cases should still read differently");
  assert.doesNotMatch(agent, /if \(finalText && endsOnAPromise\(finalText\)\) \{/,
    "the marker is conditional on the prose again");
});
