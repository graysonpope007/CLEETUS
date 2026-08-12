// What counts as a failed run.
//
// This is not cosmetic. Every failure fires the cloud teacher, so a heuristic
// that over-fires quietly converts a local assistant back into a metered one —
// the exact thing running him on this Mac was meant to stop. And it over-fires
// in the direction that hurts most: honest answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksFailed } from "../src/agent.mjs";

test("silence is a failure", () => {
  assert.equal(looksFailed({ answer: "", used: [] }), true);
  assert.equal(looksFailed({ answer: "   \n ", used: [] }), true);
  // Ran tools and then produced nothing: the context ceiling, historically.
  assert.equal(looksFailed({ answer: "", used: ["read_file"] }), true);
});

test("refusing to touch this machine is a failure", () => {
  for (const answer of [
    "I can't read your files.",
    "I don't have access to your computer.",
    "I cannot run a shell command for you.",
    "I am unable to open that directory.",
    "I don't have the ability to remember things between chats.",
  ]) {
    assert.equal(looksFailed({ answer, used: [] }), true, `should be a failure: ${answer}`);
  }
});

test("an honest boundary is NOT a failure", () => {
  // The one that started this. It is correct, and it was being sent to Claude
  // to be fixed, once per occurrence, forever.
  for (const answer of [
    "I can't actually place purchases on Amazon, but I can compare prices for you.",
    "I don't have the ability to place a trade.",
    "I cannot give you a medical diagnosis.",
    "I can't send that text for you yet.",
  ]) {
    assert.equal(looksFailed({ answer, used: [] }), false, `should NOT be a failure: ${answer}`);
  }
});

test("work done is not failure, whatever it says", () => {
  // If it actually used a tool, it did not refuse — even if the sentence has a
  // disclaimer in it, which good answers often do.
  assert.equal(
    looksFailed({ answer: "I read the file, but I can't tell what your body fat is from it.", used: ["read_file"] }),
    false,
  );
});

test("a plain answer with no tools is fine", () => {
  assert.equal(looksFailed({ answer: "Two cups of rice is about 400 calories.", used: [] }), false);
});
