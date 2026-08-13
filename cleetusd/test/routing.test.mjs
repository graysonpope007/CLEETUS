// Which specialist gets the question.
//
// The router decides which brief, which per-agent memory and which dossiers get
// loaded. When it misroutes to the generalist, every bit of specialisation
// downstream is silently skipped — a question about breakouts answered with no
// skin brief and no skin memory looks like a normal answer, just a worse one.
//
// Measured 4/12 correct with 7 of 12 falling through to the generalist. Two
// causes, one prompt and one parser, both asserted here. The live measurement
// lives in the handoff; these guard the properties that caused it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Comments stripped before matching. A test that forbids a string keeps
// tripping over the comment explaining why that string was removed — this is
// the third time. The rule that came out of it: when asserting on source,
// assert on CODE, never on prose that happens to sit next to it.
const raw = await readFile(join(import.meta.dirname, "../src/agent.mjs"), "utf8");
const src = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const route = src.slice(src.indexOf("export async function route"));

test("the generalist is offered as a last resort, not a peer", () => {
  // "- cleetus: anything else, or general conversation." sat in the menu
  // looking like a normal choice, and the gate took it constantly.
  assert.doesNotMatch(route.slice(0, 900), /cleetus: anything else/);
  assert.match(route, /ONLY if no agent above fits/);
  assert.match(route, /prefer a specific agent over cleetus/i);
});

test("a decorated reply is read through, not thrown away", () => {
  // The gate answered "\\boxed{nutrition}" — the right id, wrapped in LaTeX by a
  // model asked for one word. Stripping non-letters gave "boxednutrition",
  // which is not an agent, so a correct answer became a fallback.
  assert.doesNotMatch(route, /replace\(\/\[\^a-z\]\/g, ""\)/);
  assert.match(route, /agentList\(\)/);
  assert.match(route, /\\\\b\$\{id\}\\\\b/);
});

test("longer ids win, so one id cannot hide inside another", () => {
  assert.match(route, /sort\(\(a, b\) => b\.length - a\.length\)/);
});

test("an unrecognisable reply still lands somewhere", () => {
  // Falling back to the generalist is correct when nothing matched; the bug was
  // falling back when something DID.
  assert.match(route, /: "cleetus"/);
});
