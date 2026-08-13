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

test("a missing required argument says so, instead of reporting an empty result", async () => {
  // edit_file without `find` used to search the file for the string "undefined",
  // find nothing, and answer "Not found — match the text exactly, including
  // indentation." That is advice for a different problem: it sends the model
  // back to re-read the file and retry the identical malformed call. Checked
  // centrally in callTool, so every tool gets it.
  const out = await callTool("edit_file", { path: "/tmp/whatever.txt", old: "a", new: "b" });
  assert.match(out, /missing required arguments/);
  assert.match(out, /find/);
  assert.match(out, /replace/);
  assert.match(out, /Nothing was done/);
  assert.doesNotMatch(out, /match the text exactly/);
});

test("the guard does not fire on a complete call", async () => {
  const out = await callTool("find_files", { name: "package.json", path: "/Users/grayson/cleetusd" });
  assert.doesNotMatch(out, /missing/);
  assert.match(out, /package\.json/);
});

test("an empty string counts as missing", async () => {
  // "" is the shape a model produces when it knows it needs an argument and has
  // nothing to put there. Treating it as present makes the tool search for "".
  const out = await callTool("web_open", { url: "" });
  assert.match(out, /missing a required argument/);
});
