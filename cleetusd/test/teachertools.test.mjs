// test/teachertools.test.mjs — the toolbox the teacher describes.
//
// The teacher writes procedures for the small local model, and its system prompt
// listed the tools by hand: "read_file, write_file, edit_file, list_dir,
// search_files, find_files, run_shell, vault_search, vault_read, cloud_api,
// browse".
//
// `browse` was removed when the browser tooling was rebuilt as web_open /
// web_read / web_act. So the teacher was being told to write procedures around a
// tool that does not exist, and any skill it produced could instruct the small
// model to call it — a skill that fails on its first step, saved forever.
//
// The list also named 10 of 38. Everything added since — the keyring, mail, the
// devices, recent_work, health_report, scheduled_jobs — was invisible, so no
// skill could ever use them.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { TOOLS } from "../src/tools/index.mjs";

const src = readFileSync(new URL("../src/teacher.mjs", import.meta.url), "utf8");

test("the tool list is read from the registry, not typed out", () => {
  assert.match(src, /async function toolNames\(\)/);
  assert.match(src, /const \{ TOOLS \} = await import\("\.\/tools\/index\.mjs"\)/);
  assert.match(src, /Object\.keys\(TOOLS\)\.sort\(\)\.join\(", "\)/);
});

test("no tool is named by hand in the prompt any more", () => {
  // The specific dead name, and the shape that let it rot there.
  const system = src.slice(src.indexOf("const SYSTEM = ["), src.indexOf("].join(\"\\n\")"));
  assert.doesNotMatch(system, /\bbrowse\b/, "the dead tool is back in the prompt");
  assert.doesNotMatch(system, /read_file, write_file, edit_file/,
    "a hand-maintained list beside a registry will drift from it again");
});

test("the generated list is actually used in the call", () => {
  // A helper nothing calls is worse than the bug: it looks fixed.
  assert.match(src, /const toolList = await toolNames\(\);/);
  assert.match(src, /system: SYSTEM \+ \(toolList \?/);
  assert.ok(src.indexOf("const toolList = await toolNames();") < src.indexOf("system: SYSTEM +"),
    "it must be resolved before the call that uses it");
});

test("an unreadable registry names no tools at all", () => {
  // Never invent a toolbox. Describing tools that may not exist is the bug
  // being fixed, so the failure mode is silence.
  assert.match(src, /return null;/);
  assert.match(src, /Never invent a list/);
  assert.match(src, /toolList \? `/, "a null list must produce no tool sentence");
});

test("every tool the teacher will name actually exists", () => {
  // The whole point, asserted against the live registry.
  const names = Object.keys(TOOLS);
  assert.ok(names.length > 30, `only ${names.length} tools found — registry did not load`);
  assert.ok(!names.includes("browse"), "browse should not exist");
  for (const t of ["recent_work", "health_report", "scheduled_jobs", "web_open"]) {
    assert.ok(names.includes(t), `${t} missing from the registry`);
  }
});
