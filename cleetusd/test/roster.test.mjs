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
import { AGENTS } from "../src/agents.mjs";

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

test("the repo roster goes only to agents that can act on it", () => {
  /* It was injected everywhere, and the comment justifying that said it "costs
     a few hundred characters". Measured: 10,131 — a THIRD of the image agent's
     entire system prompt, which came to about 30,000 characters. The brief
     that tells it how to make a good picture was 16%.

     That is not free on a 33B, and it is the same shape as the agent-memory
     contamination found the same night: the operative instruction buried under
     context with nothing to do with the task, producing the symptom that was
     being chased all along.

     The PROTECTION it existed for — never answer "can you access my repos" by
     running an unbounded `find ~` — is kept for everyone as a sentence. Only
     the payload is gated. */
  const agentSrc = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");

  assert.match(agentSrc, /repos && \(isGeneralist \|\| \(agent\.needs \|\| \[\]\)\.includes\("codebase"\)\)/,
    "the roster is injected unconditionally again");
  // The one-line guard must survive for the agents that no longer get the list,
  // or the flailing it was written to stop comes straight back.
  assert.match(agentSrc, /Never go looking for repositories with find, search_files or a shell walk/,
    "the agents without the roster lost the instruction not to go hunting");
  // And the scan itself must be skipped, not run and discarded.
  assert.match(agentSrc, /\? repoIndex\(\)\.then\(rosterText\)\.catch\(\(\) => ""\)\s*\n\s*: Promise\.resolve\(""\)/,
    "the disk scan still runs for agents that will never see its output");
});

test("the agents that DO touch code still declare they need it", () => {
  // The gate reads `needs`, so an agent that works on the codebase and forgets
  // to say so silently loses the roster. Pinned so that stays visible.
  for (const id of ["builder", "studio", "redesign"]) {
    assert.ok((AGENTS[id].needs || []).includes("codebase"),
      `${id} edits code but no longer declares needs:["codebase"], so it lost the roster`);
  }
  // And the picture agent must not acquire it by accident.
  assert.ok(!(AGENTS.image.needs || []).includes("codebase"));
});

test("every instruction to add a key points at the page that has the form", () => {
  /* The dashboard at / has no Keys form. Only /reach does — six references
     there, zero in ui.mjs. Three messages told him to use "the deck's Keys
     form", including one written an hour earlier in this same repo while
     fixing a DIFFERENT wrong instruction about the same key.

     It is the cheap end of the same fault as the HF_TOKEN plumbing: that one
     sent him somewhere real to do something that could not work, this one
     sends him somewhere that does not exist. Both cost him the same evening.

     Asserted as an absence, because the failure is a phrase reappearing rather
     than a behaviour changing. */
  const dirs = ["src/tools/media.mjs", "src/tools/pi.mjs", "src/agents.mjs"];
  for (const rel of dirs) {
    const s = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.ok(!/deck'?s Keys|deck'?s secrets|deck'?s Keys-and-secrets/i.test(s),
      `${rel} still sends him to a Keys form on the deck, which has none`);
  }
  // And the one that does exist is named with an address he can actually open.
  const media = readFileSync(new URL("../src/tools/media.mjs", import.meta.url), "utf8");
  assert.match(media, /Reach page \(127\.0\.0\.1:8767\/reach\)/);
});
