// test/toolhealth.test.mjs — the tool-failure tally.
//
// This module exists because search_files failed every call for hours and the
// only witness was a line in a run file. The tests that matter here are the two
// that pull in opposite directions:
//
//   - it must fire on a tool that could not run
//   - it must NOT fire on a tool that ran and found nothing
//
// Every false positive here costs more than a miss, because a check that cries
// on honest empty results gets ignored, and an ignored check is worse than no
// check — it looks like coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksBroken, parseCalls, toolHealth } from "../src/toolhealth.mjs";

test("a tool that could not run reads as broken", () => {
  assert.equal(looksBroken("search failed: Command failed: rg --line-number", "search_files"), true);
  assert.equal(looksBroken("find failed: spawn rg ENOENT", "find_files"), true);
  assert.equal(looksBroken("No such tool: shell", "shell"), true);
  assert.equal(looksBroken("The browser harness is not running (fetch failed).", "web_open"), true);
});

test("a tool that ran and found nothing does NOT read as broken", () => {
  // Every one of these contains a negation, and a keyword rule calls them all
  // failures. They are the healthy answer to a question with no answer.
  assert.equal(looksBroken('No matches for "kayak" under /Users/grayson', "search_files"), false);
  assert.equal(looksBroken('Nothing named like "*.zzz" under /Users/grayson', "find_files"), false);
  assert.equal(looksBroken('Nothing in the vault about "sourdough"', "vault_search"), false);
  assert.equal(looksBroken("Nobody is in front of the camera", "who_is_there"), false);
});

test("a bad path is the model's mistake, not a broken tool", () => {
  // If these counted, the check would report the model's typos as an outage.
  assert.equal(looksBroken("No such file: /Users/grayson/nope.txt", "read_file"), false);
  assert.equal(looksBroken("Not found in /Users/grayson/x.mjs. Read the file and match", "edit_file"), false);
});

test("reading a file about failures is not a failure", () => {
  // The real false positive this rule was written for: doctor.mjs and the cloud
  // functions are full of their own error strings, and reading them marked
  // read_file as broken twice.
  const src = 'detail: !answered ? (ms && ms.error) || "mail not answering" : `${n} unread`,';
  assert.equal(looksBroken(src, "read_file"), false);
  assert.equal(looksBroken("const msg = `search failed: ${e.message}`;", "read_file"), false);
  // ...but read_file announcing its OWN failure at the front of the line still counts.
  assert.equal(looksBroken("could not read that file: EACCES", "read_file"), true);
});

test("a long result is a tool that worked, whatever words are in it", () => {
  const body = "x".repeat(600) + " could not ";
  assert.equal(looksBroken(body, "web_read"), false);
});

test("calls and their multi-line results are read out of a run file", () => {
  const run = [
    "## What he did",
    '- `search_files` {"query":"foo"}',
    "  /a/b.mjs:1:foo",
    "  /a/c.mjs:9:foo",
    '- `read_file` {"path":"/a/b.mjs"}',
    "  line one",
    "  line two",
    "## Answer",
    "here you go",
  ].join("\n");
  const calls = parseCalls(run);
  assert.deepEqual(calls.map((c) => c.tool), ["search_files", "read_file"]);
  assert.match(calls[0].result, /c\.mjs:9/, "a result spanning lines must not be truncated to its first");
  assert.doesNotMatch(calls[1].result, /here you go/, "the answer prose is not part of the tool result");
});

test("a tool failing every call is reported; one failing sometimes is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runs-"));
  const now = new Date(2026, 7, 14, 18, 0);
  const at = (h, m) => `2026-08-14-${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}-x.md`;

  // broken_tool: two calls, both dead. flaky_tool: one dead, one fine.
  await writeFile(join(dir, at(9, 0)), [
    '- `broken_tool` {}', "  search failed: spawn rg ENOENT",
    '- `flaky_tool` {}', "  could not reach the endpoint",
  ].join("\n"));
  await writeFile(join(dir, at(10, 0)), [
    '- `broken_tool` {}', "  search failed: spawn rg ENOENT",
    '- `flaky_tool` {}', "  all good, here is your answer",
  ].join("\n"));

  const r = await toolHealth({ runsDir: dir, days: 3, now });
  assert.deepEqual(r.alwaysBroken.map((b) => b.tool), ["broken_tool"],
    "only the tool that failed EVERY call should be reported");
  assert.equal(r.alwaysBroken[0].calls, 2);
  assert.match(r.alwaysBroken[0].example, /ENOENT/, "the report must carry the actual message");
});

test("one failed call on its own is not enough to accuse a tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runs-"));
  await writeFile(join(dir, "2026-08-14-0900-x.md"), '- `lonely_tool` {}\n  could not reach the endpoint');
  const r = await toolHealth({ runsDir: dir, days: 3, now: new Date(2026, 7, 14, 18, 0) });
  assert.deepEqual(r.alwaysBroken, [], "a website being down once is not a broken tool");
});

test("the window forgets a tool that was broken and got fixed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runs-"));
  // Broken in May, untouched since. Asking "does this work now" must not
  // resurface it — a lifetime tally answers a different question.
  await writeFile(join(dir, "2026-05-01-0900-x.md"), '- `old_tool` {}\n  search failed: gone\n- `old_tool` {}\n  search failed: gone');
  const r = await toolHealth({ runsDir: dir, days: 3, now: new Date(2026, 7, 14, 18, 0) });
  assert.equal(r.files, 0, "nothing inside the window");
  assert.deepEqual(r.alwaysBroken, []);
});
