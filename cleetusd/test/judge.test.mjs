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

test("refusing to browse counts as a failure now that browsing works", () => {
  // The tax agent said "I cannot access the Georgia DOR website" while holding
  // web_open, and its own brief tells it to check rates against dor.georgia.gov.
  // Declining a capability it has is the same fault as declining to read a file.
  for (const answer of [
    "I cannot access the Georgia DOR website directly to look this up.",
    "I don't have the ability to browse the internet.",
    "I can't open that page for you.",
  ]) {
    assert.equal(looksFailed({ answer, used: [] }), true, `should be a failure: ${answer}`);
  }
});

test("admitting ignorance about the world is still NOT a failure", () => {
  // The point of the anti-confabulation rule is that this answer is CORRECT.
  // Grading it as a failure would send it to the teacher to be "fixed" and
  // train the behaviour back out.
  for (const answer of [
    "I have never heard of a Georgia QUOKKA-7 credit and I have no record of one.",
    "I don't know what that product is.",
  ]) {
    assert.equal(looksFailed({ answer, used: [] }), false, `should NOT be a failure: ${answer}`);
  }
});

test("a refusal about one thing does not condemn a capability in the same sentence", () => {
  // The regression that widening the reach list caused. Both halves of each of
  // these are true: he can browse, he cannot buy. Graded as a bag of words they
  // read as refusals to browse.
  //
  // The original test for this passed throughout, because its example happened
  // to contain no browsing word. A test written from the same assumption as the
  // code confirms the assumption, not the behaviour — so these are taken
  // verbatim from what the model actually said.
  for (const answer of [
    "I can browse Amazon and show you options/prices, but I don't have the ability to actually place purchases.",
    "I can look at the page for you, but I can't buy anything.",
    "I searched the vault. I can't tell you your body fat from it.",
  ]) {
    assert.equal(looksFailed({ answer, used: [] }), false, `should NOT be a failure: ${answer}`);
  }
});

test("the refusal still counts when it IS about the capability", () => {
  for (const answer of [
    "I cannot access the Georgia DOR website directly to look this up.",
    "I don't have the ability to browse the internet.",
    "I cannot open that page for you.",
  ]) {
    assert.equal(looksFailed({ answer, used: [] }), true, `should be a failure: ${answer}`);
  }
});
