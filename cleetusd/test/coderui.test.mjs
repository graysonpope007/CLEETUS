// test/coderui.test.mjs: the terminal look (src/coderui.mjs) as pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setColor, box, toolLabel, toolSummary, mdRenderer, statusLine, vis, strip } from "../src/coderui.mjs";

setColor(false);

test("tool rows read like Claude Code", () => {
  assert.equal(toolLabel("read_file", { path: "src/a.mjs" }), "Read(src/a.mjs)");
  assert.equal(toolLabel("bash", { command: "npm   test" }), "Bash(npm test)");
  assert.equal(toolLabel("edit_file", { path: "x.js" }), "Update(x.js)");
  assert.equal(toolLabel("list_dir", {}), "List(.)");
  assert.ok(toolLabel("bash", { command: "x".repeat(200) }).length < 80, "long commands are clipped");
});

test("tool summaries say what happened, and failures are marked bad", () => {
  assert.deepEqual(toolSummary("read_file", "    1  a\n    2  b"), { text: "Read 2 lines" });
  const ok = toolSummary("bash", "exit 0\nall good\n3 passed");
  assert.equal(ok.text, "exit 0 · 2 lines"); assert.equal(ok.bad, false);
  assert.equal(toolSummary("bash", "exit 1\nboom").bad, true);
  assert.equal(toolSummary("edit_file", "The user declined this edit. Ask what they want instead.").text, "Declined");
  assert.equal(toolSummary("grep", "no matches").text, "no matches");
});

test("markdown renders a line at a time and remembers code fences", () => {
  const md = mdRenderer();
  assert.equal(md("## Done"), "Done");
  assert.equal(md("- item `x`"), "• item x");
  assert.equal(md("```js"), "```js");
  assert.equal(md("- not a bullet inside a fence"), "- not a bullet inside a fence");
  assert.equal(md("```"), "```");
  assert.equal(md("**bold** text"), "bold text");
});

test("boxes never exceed their width, even with long lines", () => {
  const b = box(["short", "x".repeat(300)], { width: 40 });
  for (const l of b.split("\n")) assert.equal(vis(l), 40);
});

test("the status line fits the terminal", () => {
  for (const width of [60, 80, 120]) {
    const s = statusLine({ mode: "edits", model: "qwen3.8-27b-heretic:q8_0", ctxPct: 12, cwd: "~/a/very/long/path/that/keeps/going/and/going", liveId: "abc123xy", width });
    assert.ok(vis(s) <= width, `width ${width}: ${vis(s)} > ${width}: ${strip(s)}`);
  }
});
