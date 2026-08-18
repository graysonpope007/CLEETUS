// test/escapehatch.test.mjs — prompts that offer the model a way out.
//
// This codebase has learned the same lesson twice, in different words.
//
//   agent.mjs, askToFill: ended "never ask for something the answer does not
//   actually depend on". The model took it, decided the dossier was not needed,
//   and produced advice that would fit a stranger. Its comment now reads: "A
//   get-out clause in a prompt WILL be used."
//
//   jobs.mjs, nightly-consolidation: ended "If there is nothing durable, reply
//   with exactly: NOTHING". Measured against a digest containing two unmissable
//   facts, it extracted on 1 run in 7. The job ran every night, reported ok, and
//   promoted nothing.
//
// The shape is specific enough to test for: a prompt that names a sentinel the
// model can return INSTEAD of doing the work. Offering one is often necessary —
// a job needs a way to say a quiet day was quiet — so the rule is not "never
// offer an exit". It is that the exit must come after the work and be
// conditional on having done it.

import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

function sources() {
  const out = [];
  for (const dir of ["src", "src/tools", "bin"]) {
    for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      if (!f.endsWith(".mjs")) continue;
      const raw = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8");
      // Comments quote these phrases on purpose — including this file's reasons
      // being pasted into the source next to the fix. Strip them or the guard
      // fires on its own explanation.
      const code = raw.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      out.push([`${dir}/${f}`, code]);
    }
  }
  return out;
}

test("a prompt offering a sentinel must demand the work first", () => {
  const QUALIFIERS = /if and only if|only if you have|after you have (read|checked|looked)/i;
  const offenders = [];
  for (const [name, code] of sources()) {
    // "reply/respond with exactly: X" is the shape that lets a model answer
    // without doing anything.
    const m = code.match(/(?:reply|respond|answer) with exactly/i);
    if (!m) continue;
    if (!QUALIFIERS.test(code)) offenders.push(name);
  }
  assert.deepStrictEqual(offenders, [],
    "a sentinel exit with no condition attached — the model will take it");
});

test("the consolidation prompt orders the two halves correctly", () => {
  const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
  const work = src.indexOf("Read every line above and find the places");
  const exit = src.indexOf("If and only if you have read it all");
  assert.ok(work > 0 && exit > work,
    "the permission to decline must come after the instruction to work");
});

test("the anti-confabulation exit is NOT flagged", () => {
  // "If you do not know something, say so in one short sentence and stop" is the
  // opposite kind of instruction: it asks for honesty rather than offering an
  // escape from work. A guard that cannot tell these apart would push the
  // codebase towards removing the one line that prevents invention.
  const src = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
  assert.match(src, /If you do not know something, say so in one short sentence and stop/,
    "this instruction should still be present");
  assert.doesNotMatch(src, /If you do not know something[^"]*reply with exactly/i,
    "it is not a sentinel exit and must not be rewritten as one");
});
