// test/resolvedruns.test.mjs — the bridge between two systems that were not talking.
//
// A run file records `status: failed` once and keeps it forever, so a question
// stayed on Grayson's open-loops list for seven days no matter what happened
// next. The improve loop had meanwhile re-run six of those questions, got good
// answers, and written "verified fixed" into a state file nobody reads. The
// worklist he DOES read showed five open items when one was open.
//
// The direction of failure matters here more than the accuracy. Listing
// something already handled wastes his attention; dropping something still open
// loses work. So every ambiguous case must resolve toward LISTING it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvedRunKeys } from "../src/jobs.mjs";

async function stateWith(history) {
  const dir = await mkdtemp(join(tmpdir(), "improve-"));
  const f = join(dir, "improve-state.json");
  await writeFile(f, JSON.stringify({ day: "2026-08-14", count: 0, history }));
  return f;
}

test("a run improve re-ran and answered is resolved", async () => {
  const f = await stateWith([
    { key: "run:2026-08-12-1541-search-my-vault.md", outcome: "verified fixed by re-running the original question" },
    { key: "run:2026-08-12-2116-can-you-fix-studio-locate.md", outcome: "cause already fixed — not re-attempted" },
  ]);
  const r = await resolvedRunKeys(f);
  assert.equal(r.size, 2);
  assert.ok(r.has("2026-08-12-1541-search-my-vault.md"), "the `run:` prefix must be stripped to match the filename");
});

test("shipping a change that did not fix anything is NOT resolution", async () => {
  // Section 118: a change shipped for push while push stayed down. The outcome
  // string says so, and this must not read the word "failing" as "fixed".
  const f = await stateWith([
    { key: "run:a.md", outcome: "shipped, but push is still failing" },
    { key: "run:b.md", outcome: "shipped" },
    { key: "run:c.md", outcome: "no change made" },
    { key: "run:d.md", outcome: "gates failed" },
    { key: "run:e.md", outcome: "reverted" },
  ]);
  const r = await resolvedRunKeys(f);
  assert.deepEqual([...r], [], "none of these mean the question was answered");
});

test("health and log entries are not run files", async () => {
  const f = await stateWith([
    { key: "health:push", outcome: "verified fixed" },
    { key: "log:Error [ERR_HTTP_HEADERS_SENT]", outcome: "verified fixed" },
  ]);
  assert.deepEqual([...await resolvedRunKeys(f)], [], "only `run:` keys name a run file");
});

test("a missing state file lists everything rather than clearing the worklist", async () => {
  const r = await resolvedRunKeys(join(tmpdir(), "definitely-not-here-9f31.json"));
  assert.deepEqual([...r], [], "empty set means nothing is suppressed");
});

test("an unreadable state file also fails toward listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "improve-"));
  const f = join(dir, "broken.json");
  await writeFile(f, "{ this is not json");
  // The dangerous bug would be a parse error that somehow suppressed items.
  // An empty set is the safe direction: everything stays on his list.
  assert.deepEqual([...await resolvedRunKeys(f)], []);
});

test("history with no outcome at all is not treated as resolved", async () => {
  const f = await stateWith([{ key: "run:a.md" }, { key: "run:b.md", outcome: null }]);
  assert.deepEqual([...await resolvedRunKeys(f)], []);
});
