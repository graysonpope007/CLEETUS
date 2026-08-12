// The desk light, tested without needing the light.
//
// The valuable case here is not "on works" — that needs hardware and the light
// travels. It is the argument guard: `brightness` with no value used to shell
// out and come back with a Python ValueError, which reads to the model as the
// light being broken rather than as its own call being incomplete. A model
// that thinks the hardware failed stops trying; one told it forgot a number
// tries again with the number.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolSchemas, callTool } from "../src/tools/index.mjs";

test("desk_light is registered and reaches the model", () => {
  assert.ok(TOOLS.desk_light, "desk_light missing from the registry");
  const schema = toolSchemas().find((t) => t.function.name === "desk_light");
  assert.ok(schema, "desk_light is not in the schemas handed to Ollama");
  assert.deepEqual(schema.function.parameters.required, ["action"]);
});

test("the description names the words Grayson actually uses", () => {
  const d = TOOLS.desk_light.schema.description.toLowerCase();
  for (const word of ["light", "brightness", "key light", "litra"]) {
    assert.ok(d.includes(word), `description should mention "${word}"`);
  }
});

test("brightness and temp without a value are refused before touching USB", async () => {
  for (const action of ["brightness", "temp", "temperature"]) {
    const out = await TOOLS.desk_light.run({ action });
    assert.match(out, /needs a value/, `${action} should ask for a value`);
    // The point of the guard: it must not read like the device failed.
    assert.doesNotMatch(out, /not plugged in|did not take/);
  }
});

test("value 0 is a real brightness, not a missing argument", async () => {
  // `value: 0` is falsy. A truthiness check here would reject "turn it all the
  // way down", which is a thing someone asks for.
  const out = await TOOLS.desk_light.run({ action: "brightness", value: 0 });
  assert.doesNotMatch(out, /needs a value/);
});

test("the names the model guesses resolve to the tools we have", async () => {
  // `shell` cost a wasted step and a "No such tool" every time it came up,
  // which was often. An alias is cheaper than winning an argument in a prompt.
  const out = await callTool("shell", { command: "echo alias-works" });
  assert.match(out, /alias-works/);
  assert.doesNotMatch(out, /No such tool/);
});

test("a genuinely unknown tool still says so", async () => {
  // The alias table must not turn every typo into a silent no-op.
  assert.match(await callTool("frobnicate", {}), /No such tool/);
});
