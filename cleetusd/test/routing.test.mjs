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

test("the generalist has a described domain, not a vague catch-all", () => {
  // This test used to require the words "ONLY if no agent above fits", from
  // when cleetus was framed as a last resort. That framing was replaced
  // deliberately, and the reasoning is in the source: pushed hard enough away
  // from the generalist, the router sent "is anyone in the room with me" to
  // skin and "how much free disk space do I have" to finance. Each answered
  // correctly — the tools are shared — while the deck announced the wrong
  // agent and the wrong brief was loaded.
  //
  // So the requirement is not "cleetus last". It is that cleetus is neither an
  // "anything else" bucket NOR crowded out: it owns the machine, the room and
  // the history, and specialists own their subjects.
  assert.doesNotMatch(route.slice(0, 900), /cleetus: anything else/,
    "the vague catch-all wording is what the gate used to grab");
  assert.match(route, /cleetus: the machine itself/,
    "the generalist needs a stated domain or the router cannot pick it on purpose");
  assert.match(route, /this Mac, files, disks, the shell, the room, the cameras/,
    "those are the things no specialist covers");
  // Matched on a run of text that is contiguous in the SOURCE. "belongs to a
  // specialist" is split across a string concatenation there, so asserting the
  // readable phrase would silently never match.
  assert.match(route, /body, money, clothes, food or work belongs to a/,
    "specialists must still be preferred for their own subjects");
  assert.match(route, /do not stretch/,
    "the instruction against forcing a specialist onto an unrelated question");
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
