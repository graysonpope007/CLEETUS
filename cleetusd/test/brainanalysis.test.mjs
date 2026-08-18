// test/brainanalysis.test.mjs — the weekly self-assessment, and what it may claim.
//
// This job is handed a list of question TITLES and asked where it is falling
// down. With no evidence about what actually ran, it produced a mechanism
// anyway: on 14 Aug it concluded "you're not actually looking at the camera
// output, you're just saying you can't see images" and recommended calling
// `look` and `who_is_there`. Both had run five times that week. Both cameras
// were off the USB bus, so the advice was to assert a capability the machine
// did not have — the invented-desk failure in a different costume.
//
// Adding the tool counts killed that claim and did not kill invention. The next
// run closed with "The desk light is currently at 2700K warm white, 50%
// brightness — on": a live hardware reading, in a weekly retrospective, from a
// job that has no tools at all.
//
// These assert the two guards are present in the prompt. That is a weaker kind
// of test than this repository prefers — asserting shape, not behaviour — and
// it is the right level here for one reason: the behaviour belongs to a model,
// so the only thing this code owns IS the instruction. What the model then does
// with it was checked by running the job twice and reading the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
const job = src.slice(src.indexOf('"brain-analysis"'), src.indexOf('"chat"'));

test("the analysis is given what it actually called, not just what it was asked", () => {
  assert.match(job, /toolHealth\(/, "the tally is the evidence that makes the question answerable");
  assert.match(job, /Tools you actually called this week/);
});

test("it is told not to recommend a tool it already calls often", () => {
  // The exact wrong advice from 14 Aug: call `look`, which it called five times.
  // The phrase is split across a string concatenation in the source, so match
  // the distinctive tail rather than the whole sentence.
  assert.match(job, /recommend calling one you already call often/i);
  assert.match(job, /Do not claim you failed to call a tool that appears above/i);
});

test("it is forbidden from describing the current state of anything", () => {
  // The desk light line. This job has no tools, so every present-tense claim
  // about a device is invented by construction.
  assert.match(job, /no tools here and you cannot see the machine/i);
  assert.match(job, /Say NOTHING about the current state of/i);
});

test("it is told the limits of its own evidence", () => {
  assert.match(job, /seeing the QUESTIONS and the tool counts, not the answers/i);
});

test("the counts come from the run files, bounded so they cannot swamp the prompt", () => {
  assert.match(job, /\.slice\(0, 18\)/, "an unbounded tool list would crowd out the week itself");
});
