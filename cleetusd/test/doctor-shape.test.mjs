// The report must be the same size every time.
//
// A check that disappears is not a check that passed. Four airpad checks lived
// behind "did airpad answer", so with airpad down the report quietly shrank and
// still said "all clear" about what was left — the count changed and nothing
// said why. Same shape as the flights check that skipped silently on every run
// for weeks.
//
// Asserted against the source because running the real doctor needs the live
// machine, and the property under test is structural: every conditional block
// must have a matching skip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Comments stripped: a test that forbids a string must not read the prose
// explaining the string. Learned three times over.
const raw = await readFile(join(import.meta.dirname, "../src/doctor.mjs"), "utf8");
const src = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("every gated block emits skips when its precondition fails", () => {
  for (const [gate, sample] of [
    ["airpad", "camera producing NEW frames"],
    ["cleetusd /health", "ollama has the model"],
    ["site login", "flights swept by the Mac"],
  ]) {
    assert.ok(src.includes(sample), `${sample} vanished from the doctor`);
  }
  // Each name below is emitted twice: once as a real check, once as a skip.
  for (const name of ["camera producing NEW frames", "tracker thread alive",
                      "ollama has the model", "flights swept by the Mac"]) {
    const hits = src.split(name).length - 1;
    assert.ok(hits >= 2, `"${name}" has no skip path — it vanishes when its service is down`);
  }
});

test("every service the doctor watches has a launch agent", () => {
  // The original version of this test asserted the OPPOSITE: that studio-locate
  // had no agent and must not be told to restart one. That was true and is not
  // any more — it was the only service without one, which is exactly why it was
  // the one that kept being down. It has com.cleetus.studio now, so the test
  // that guarded the workaround guards the fix instead.
  const ports = src.slice(src.indexOf("const PORTS"), src.indexOf("for (const [name, url] of PORTS)"));
  const watched = [...ports.matchAll(/\["([a-z-]+)",/g)].map((m) => m[1]);
  const agents = src.slice(src.indexOf("const AGENTS"), src.indexOf("const uid"));
  for (const name of watched) {
    const label = name === "cleetus-web" ? "web" : name === "studio-locate" ? "studio" : name;
    assert.match(agents, new RegExp(`com\\.cleetus\\.${label}\\b`),
      `${name} is watched on a port but has no launch agent in the list`);
  }
});

test("plists are checked with a STRICT parser", () => {
  // launchd accepts XML that is not valid XML — a double hyphen in a comment.
  // Three plists here had one, including one written minutes after documenting
  // the trap. PlistBuddy would not have caught it; plistlib does.
  assert.match(src, /plistlib/);
  assert.match(src, /every plist is valid XML/);
});

test("skips are marked, not counted as passes", () => {
  // skip() sets ok:true so it does not fail the run, and skipped:true so the
  // printer and the deck can tell it apart. Both matter.
  assert.match(src, /skipped: true, ok: true/);
  assert.match(src, /results\.filter\(\(r\) => !r\.ok && !r\.skipped\)/);
});
