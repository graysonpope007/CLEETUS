// test/finishthejob.test.mjs — the builder must do the work, not describe it.
//
// From a real session: "make studio locate have facial recognition to me and
// lock down all money stuff if face id doesnt recognize me". The agent spent
// all twenty tool calls on read_file and list_dir, then answered with a section
// headed "What Needs to Be Added for Your Request" that listed the three things
// it had just been asked to add. It also referred to a security.py it had
// written itself and said it "couldn't see its contents".
//
// Two separate faults: a budget too small to fit a build, and nothing telling
// it that a description is not a deliverable.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const agent = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");

test("the budget can grow while the model is still using tools", () => {
  assert.match(config, /maxStepsCeiling: Number\(env\.CLEETUSD_MAX_STEPS_CEILING \|\| (\d+)\)/,
    "there must be a ceiling the budget can climb to");
  const ceiling = Number(config.match(/CLEETUSD_MAX_STEPS_CEILING \|\| (\d+)/)[1]);
  const base = Number(config.match(/CLEETUSD_MAX_STEPS \|\| (\d+)/)[1]);
  assert.ok(ceiling > base * 2, `ceiling ${ceiling} is not meaningfully above the base budget ${base}`);
  assert.match(agent, /maxSteps \+= grant/, "the loop must actually extend the budget");
  assert.match(agent, /step === maxSteps - 1 && maxSteps < ceiling/,
    "extension must trigger on the last step while under the ceiling");
});

test("extension is bounded, not unlimited", () => {
  assert.match(agent, /const ceiling = Math\.max\(maxSteps, CONFIG\.maxStepsCeiling\)/,
    "a run must not be able to extend forever");
  assert.match(agent, /Math\.min\(ceiling - maxSteps/, "each grant must be clamped to the ceiling");
});

test("a caller can still ask for a smaller budget on purpose", () => {
  // The probe path and the tests rely on being able to pass a tiny budget.
  assert.match(agent, /maxSteps = CONFIG\.maxSteps/, "the parameter default must survive");
});

test("the prompt says to make the change, not describe it", () => {
  assert.match(agent, /DO IT\. Write the file, make the edit, run the command/);
  assert.match(agent, /prologue, not the deliverable/);
  assert.match(agent, /Never hand back a plan as though it were the work/);
  assert.match(agent, /spend what is left MAKING THE CHANGE/);
});

test("the ran-out marker reports how many extensions were granted", () => {
  // Otherwise a run that extended four times and still failed looks identical
  // to one that never got past twenty, and the ceiling looks fine when it isn't.
  assert.match(agent, /extended \$\{extensions\}/);
});
