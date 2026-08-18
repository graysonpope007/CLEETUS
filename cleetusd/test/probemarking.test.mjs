// test/probemarking.test.mjs — telling his requests apart from the system's own.
//
// The weekly analysis told Grayson: "You keep asking me to find DOCTOR_PROBE_KEY
// and paste it into forms." He never asked that once. It was a security probe
// checking the keyring would refuse to print a secret — asked twice, on purpose
// — and the system read its own test traffic back as a description of his
// behaviour, then drew conclusions about what to change from it.
//
// A filter for `probe: true` already existed in memory.mjs and had never
// filtered anything, because nothing wrote the marker. Nine runs carried it only
// because an earlier session went and added it by hand.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("startRun can write the marker the filters look for", () => {
  const src = read("memory.mjs");
  assert.match(src, /export async function startRun\(\{ agent, request, probe = false \}\)/,
    "startRun must accept the flag");
  assert.match(src, /\(probe \? `probe: true\\n` : ""\)/,
    "and actually write it into the frontmatter");
});

test("the marker written matches the pattern that filters it", () => {
  // The two halves live in different files and are easy to drift apart. A
  // writer emitting `probe:true` against a filter wanting `probe: true` would
  // leave everything exactly as broken as before, silently.
  const written = "probe: true";
  for (const [file, src] of [["memory.mjs", read("memory.mjs")], ["jobs.mjs", read("jobs.mjs")]]) {
    const m = src.match(/\/\^probe:\\s\*true\\s\*\$\/m/);
    assert.ok(m, `${file} should filter on the anchored pattern`);
    assert.match(written, /^probe:\s*true\s*$/m, `${file}'s pattern must match what startRun writes`);
  }
});

test("BOTH readers exclude probes, not just one", () => {
  // recentRuns() (the deck's list) was filtered; recentRunFiles() (the weekly
  // analysis and the nightly consolidation) was not. The second is the one that
  // reasons about the runs and writes to MEMORY.md, so it mattered more.
  assert.match(read("memory.mjs"), /if \(\/\^probe:\\s\*true\\s\*\$\/m\.test\(text\)\) continue;/);
  assert.match(read("jobs.mjs"), /if \(!includeProbes && \/\^probe:\\s\*true\\s\*\$\/m\.test\(text\)\) continue;/);
});

test("the flag reaches ask() from the HTTP surface", () => {
  // Both chat routes, or the streaming one silently records probes as his.
  const server = read("server.mjs");
  // Asserted per destination, not as a total. The first version required
  // exactly two occurrences and broke when conversations learned the same
  // distinction — the count went to four because convos.open() now takes it
  // too, which is the fix working, not a regression.
  const toAsk = server.match(/ask\(\{[^}]*probe: body\.probe === true/g) || [];
  const toConvo = server.match(/convos\.open\([^)]*probe: body\.probe === true/g) || [];
  assert.ok(toAsk.length + toConvo.length >= 4,
    `only ${toAsk.length} ask + ${toConvo.length} convos.open pass the flag`);
  assert.strictEqual(toConvo.length, 2, "both routes must mark the conversation too");
  // Asserted as "the signature accepts this parameter", not as the exact
  // parameter list. The first version pinned the whole signature verbatim and
  // broke the moment an unrelated option (maxSteps) was added beside it — a test
  // that fails on a change it does not care about teaches people to edit tests
  // without reading them.
  assert.match(read("agent.mjs"), /export async function ask\(\{[^}]*\bprobe = false\b[^}]*\}\)/);
  assert.match(read("agent.mjs"), /startRun\(\{ agent: agentId, request: question, probe \}\)/);
});

test("probe defaults to false, so ordinary traffic is never hidden from him", () => {
  // The dangerous inversion: if this defaulted true, his real requests would
  // vanish from the analysis and the deck, and nothing would look wrong.
  assert.match(read("agent.mjs"), /probe = false/);
  assert.match(read("memory.mjs"), /probe = false/);
  assert.match(read("server.mjs"), /body\.probe === true/,
    "strict equality — a truthy string from a stray query param must not mark a run");
});

test("EVERY caller of ask() decides about the probe flag", () => {
  // The fix was applied to the callers where the bug was noticed — the two HTTP
  // routes and askModel — and then to improve.mjs when its builder run turned up
  // in his open loops. bin/ask.mjs was the fifth and had no way to mark itself
  // at all, so every test question asked from a terminal landed in his activity.
  // That is how the weekly analysis came to tell him he kept asking for a secret
  // he had never mentioned.
  //
  // This enumerates the callers rather than checking the ones already known, so
  // a sixth cannot be added silently.
  const { readdirSync, readFileSync } = require_fs();
  const callers = [];
  for (const dir of ["src", "src/tools", "bin"]) {
    for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      if (!f.endsWith(".mjs") || `${dir}/${f}` === "src/agent.mjs") continue;
      const body = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8");
      // Brace-matched, not a fixed window. The first version of this capped the
      // call at 400 characters and silently missed improve.mjs, whose ask()
      // carries a long comment — so the test that exists to catch a missed
      // caller missed one, and reported four where there are five. That is the
      // same fixed-window mistake this file keeps documenting elsewhere.
      let at = body.indexOf("await ask({");
      while (at !== -1) {
        let depth = 0, end = at;
        for (let k = body.indexOf("{", at); k < body.length; k++) {
          if (body[k] === "{") depth++;
          else if (body[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
        }
        callers.push([`${dir}/${f}`, body.slice(at, end + 1)]);
        at = body.indexOf("await ask({", end);
      }
    }
  }
  assert.ok(callers.length >= 5, `only found ${callers.length} callers of ask()`);
  const silent = callers.filter(([, call]) => !/probe/.test(call)).map(([f]) => f);
  assert.deepStrictEqual(silent, [],
    "these call ask() without deciding whether the run is his or the system's");
});

test("the CLI defaults to HIS question, not a probe", () => {
  // The dangerous inversion: defaulting to probe would hide his own history
  // from him, which is worse than the pollution being fixed.
  const cli = require_fs().readFileSync(new URL("../bin/ask.mjs", import.meta.url), "utf8");
  assert.match(cli, /const probe = p !== -1;/);
  assert.doesNotMatch(cli, /const probe = true/);
  assert.match(cli, /\[--probe\]/, "the usage line should mention it");
});

function require_fs() { return fsmod; }
import * as fsmod from "node:fs";
