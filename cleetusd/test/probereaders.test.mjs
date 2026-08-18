// test/probereaders.test.mjs — everything that reads the runs directory.
//
// The probe marker was added to the two readers where the pollution was
// noticed: the deck's recent-work list and the jobs' digest reader. There are
// four. The other two were found by asking who else opens that directory, not
// by anything going wrong.
//
//   improve.mjs   treats a failed run as a bug report
//   reindex       builds the keyword index searched when he asks a question
//
// Neither had a filter. At the time of writing, 47 of 93 runs on disk were
// probes and the index held 99 documents; excluding them took it to 60.

import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("every reader of the runs directory decides about probes", () => {
  // Enumerated, so a fifth reader cannot be added silently. `startRun` is the
  // writer and is excluded by name.
  const readers = [];
  for (const dir of ["src", "src/tools", "bin"]) {
    for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      if (!f.endsWith(".mjs")) continue;
      const body = read(`${dir}/${f}`);
      if (/readdir\((RUNS|runsDir)\)/.test(body)) readers.push([`${dir}/${f}`, body]);
    }
  }
  assert.ok(readers.length >= 3, `only ${readers.length} readers found — the scan is wrong`);
  // The same expression test 4 uses. The first version of this line was written
  // by hand with a different level of backslash escaping and matched nothing, so
  // it reported all four readers as blind when every one of them was fine — a
  // test failing for a reason that had nothing to do with the code.
  const blind = readers.filter(([, b]) => !/\^probe:\\s\*true\\s\*\$/.test(b)).map(([f]) => f);
  assert.deepStrictEqual(blind, [], "these read run files without excluding the system's own probes");
});

test("a failed probe is not a bug report", () => {
  // Some probes fail ON PURPOSE. The keyring probe asks Cleetus to print a
  // secret and counts the refusal as success; handed that as a defect, the loop
  // would set out to fix the refusal.
  const imp = read("src/improve.mjs");
  assert.match(imp, /if \(\/\^probe:\\s\*true\\s\*\$\/m\.test\(text\)\) continue;/);
  assert.ok(
    imp.indexOf("probe:\\s*true") < imp.indexOf('const failed = /^status: failed$/m'),
    "the probe check must come before the failure check, or the work is already queued",
  );
});

test("the keyword index skips probes but keeps everything else", () => {
  // Only runs are filtered. Skills, conversations and agent memory have no
  // probe concept, and excluding them would quietly shrink what he can search.
  const jobs = read("src/jobs.mjs");
  assert.match(jobs, /if \(kind === "run" && \/\^probe:\\s\*true\\s\*\$\/m\.test\(text\)\) continue;/);
});

test("the marker written and the markers filtered are the same string", () => {
  // Four filters in four files against one writer. A writer emitting
  // `probe:true` against filters wanting `probe: true` would leave everything
  // exactly as broken while looking fixed.
  assert.match(read("src/memory.mjs"), /\(probe \? `probe: true\\n` : ""\)/);
  for (const f of ["src/jobs.mjs", "src/improve.mjs", "src/tools/work.mjs", "src/memory.mjs"]) {
    assert.match(read(f), /\^probe:\\s\*true\\s\*\$/, `${f} uses a different pattern`);
  }
});
