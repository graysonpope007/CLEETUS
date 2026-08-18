// test/skillhonesty.test.mjs — what the loop is allowed to write down as learned.
//
// The first autonomous cycle wrote a skill whose second step was: add a
// Content-Type header to the crumb function in _lib/apns.js. That change was
// never made, that file was never touched, and it is not why push is down —
// nothing has been pushed since 9 August.
//
// The fiction travelled: a truncated answer became the commit message, the
// commit message became a skill, and skills are retrieved into future prompts.
// It would have misdirected the next attempt at this exact problem, carrying the
// authority of something the system had "learned". It was caught at uses=0.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/improve.mjs", import.meta.url), "utf8");

test("no skill is written from a truncated answer", () => {
  // A summary written after running out of room describes intentions. A
  // procedure made of intentions is worse than no procedure, because someone
  // will follow it.
  assert.match(src, /const truncatedAnswer = /);
  assert.match(src, /if \(truncatedAnswer \|\| stillFailing\)/);
});

test("no skill is written while the issue is still failing", () => {
  // "Shipped and nothing else broke" is not "fixed". The cycle that produced
  // the false skill left push exactly as down as it found it.
  assert.match(src, /const stillFailing = checkName && after && \(after\.down \|\| \[\]\)\.includes\(checkName\)/);
  assert.match(src, /startsWith\("health:"\) \? issue\.key\.slice\(7\) : null/);
});

test("the steps point at the diff, not at the model's prose", () => {
  // The prose is where the invention lives. The file list comes from git.
  assert.match(src, /What actually changed: \$\{changed\.join\(", "\)\}/);
  assert.doesNotMatch(src, /steps: \[issue\.hint, result\.answer/,
    "the model's answer is back in the procedure");
});

test("skipping is logged, not silent", () => {
  // A skill that quietly does not get written looks identical to a cycle that
  // had nothing to teach.
  assert.match(src, /log\("no skill written:"/);
});

test("the surviving skills are the ones actually being used", () => {
  // Not a code assertion — a note. At the time of writing the five remaining
  // skills had 42, 37, 36, 7 and 2 uses; the false one had 0. The retrieval
  // path works, which is exactly why a wrong entry in it matters.
  assert.ok(true);
});
