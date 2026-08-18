// test/toolresultshape.test.mjs — what a tool hands back to the model.
//
// The worst bug in this codebase's history was not a crash. `look` returned an
// object, the loop did String() on it, and the model received the literal text
// "[object Object]". It did not say the tool had failed. It described the desk —
// an MX Master 3, an iPhone 15 Pro Max — none of which anyone had looked at.
//
// Two runs on 13 Aug are preserved evidence: the step recorded as
// "[object Object]", followed by a confident inventory of a desk nobody saw.
//
// vision.mjs was fixed by making every path in that one tool return a string.
// This tests the structural version: thirty-eight tools, any of which can grow
// a bad path, where the symptom is never an error — it is a believable answer
// about something that was never observed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceResult, TOOLS, callTool } from "../src/tools/index.mjs";

test("a string passes through untouched", () => {
  assert.equal(coerceResult("look", "Through the desk camera: a keyboard."), "Through the desk camera: a keyboard.");
  assert.equal(coerceResult("x", ""), "", "an empty string is a real answer and not the loop's to rewrite");
});

test("an object is never handed over as [object Object]", () => {
  const out = coerceResult("look", { b64: "abc", bytes: 12 });
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.match(out, /bytes/, "the information was there; only the formatting was lost");
});

test("nothing at all is reported as nothing, in words", () => {
  // This is the case that produced the invented desk. The model must be told
  // there was no result, because an empty gap is what it fills.
  for (const empty of [null, undefined]) {
    const out = coerceResult("look", empty);
    assert.match(out, /returned nothing at all/);
    assert.match(out, /rather than describing what is usually there/,
      "the instruction not to invent has to travel with the empty result");
  }
});

test("a value that cannot be serialised still says so rather than going quiet", () => {
  const circular = {};
  circular.self = circular;
  const out = coerceResult("weird_tool", circular);
  assert.match(out, /could not be read/);
  assert.match(out, /no answer/);
});

test("the coercion runs on the real dispatch path", () => {
  // A helper nothing calls is not a fix. This asserts callTool routes through it.
  const src = TOOLS ? String(callTool) : "";
  assert.match(src, /coerceResult/, "callTool must coerce, not just return tool.run()");
});

test("every registered tool declares a run function", () => {
  // Cheap, and it is the precondition for any of the above meaning anything.
  const bad = Object.entries(TOOLS).filter(([, t]) => typeof t.run !== "function").map(([n]) => n);
  assert.deepEqual(bad, []);
});

test("a tool that returns an object comes back readable through callTool", async () => {
  // End to end rather than through the helper alone: a deliberately misbehaving
  // tool, dispatched the way the agent loop dispatches, must not produce the
  // string that started all this.
  const original = TOOLS.list_dir.run;
  try {
    TOOLS.list_dir.run = async () => ({ entries: ["a", "b"], truncated: false });
    const out = await callTool("list_dir", { path: "/tmp" });
    assert.doesNotMatch(String(out), /\[object Object\]/);
    assert.match(String(out), /entries/);
  } finally {
    TOOLS.list_dir.run = original;
  }
});

test("a tool that returns undefined comes back as an explicit non-answer", async () => {
  const original = TOOLS.list_dir.run;
  try {
    TOOLS.list_dir.run = async () => undefined;
    const out = await callTool("list_dir", { path: "/tmp" });
    assert.match(String(out), /returned nothing at all/);
  } finally {
    TOOLS.list_dir.run = original;
  }
});
