// test/roster.test.mjs — the repo list injected into every prompt.
//
// ~740 tokens of working trees go into every system prompt, and the index behind
// them is a cache with a six-hour life. Measured an hour after a rebuild:
//
//   cleetus-web   roster says dirty=0   on disk: 1
//
// A dirty count off by one is harmless. The same staleness applies to the branch
// name, where it would not be — and the roster was presenting all of it as
// current fact.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { rosterText } from "../src/repos.mjs";

const src = readFileSync(new URL("../src/repos.mjs", import.meta.url), "utf8");

test("the roster says when it was taken", () => {
  const out = rosterText({
    github_account: "graysonpope007",
    built_at: "2026-08-14T18:30:05.319Z",
    local: [{ name: "cleetusd", path: "/Users/grayson/cleetusd", branch: "main", dirty: 0 }],
  });
  assert.match(out, /This list was taken at \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.match(out, /is not live/);
});

test("it says what to do when the answer depends on live state", () => {
  // Dating it without saying so would leave the model to infer that a snapshot
  // is not authoritative, which is the inference that was already going wrong.
  const out = rosterText({ built_at: "2026-08-14T18:30:05.319Z", local: [{ name: "x", path: "/x" }] });
  assert.match(out, /Run git if the answer depends on either/);
});

test("the timestamp is local, not UTC", () => {
  // The index stores ISO/UTC. Printing that raw would put a time four hours off
  // his clock into every prompt — the same bug fixed in four other places.
  const out = rosterText({ built_at: "2026-08-14T18:30:05.319Z", local: [{ name: "x", path: "/x" }] });
  const m = out.match(/taken at (\d{4}-\d\d-\d\d \d\d:\d\d)/);
  assert.ok(m, "a timestamp should be present");
  const shown = new Date(m[1].replace(" ", "T")).getTime();
  assert.strictEqual(Math.floor(shown / 60000), Math.floor(Date.parse("2026-08-14T18:30:05.319Z") / 60000));
});

test("an index with no build time still produces a roster", () => {
  // Older caches have no built_at. Losing the whole repo list over a missing
  // field would be far worse than an undated one.
  const out = rosterText({ local: [{ name: "cleetusd", path: "/Users/grayson/cleetusd" }] });
  assert.match(out, /cleetusd/);
  assert.doesNotMatch(out, /taken at/);
});

test("no index at all is an empty string, not a crash", () => {
  assert.strictEqual(rosterText(null), "");
  assert.strictEqual(rosterText(undefined), "");
});

test("the TTL is left long on purpose", () => {
  // Scanning 34 working trees on every request would cost more than a stale
  // line. The fix was to date it, not to rebuild it more often.
  assert.match(src, /CLEETUSD_REPO_TTL_MS \|\| 6 \* 60 \* 60 \* 1000/);
  assert.match(src, /The fix is not a shorter TTL/);
});
