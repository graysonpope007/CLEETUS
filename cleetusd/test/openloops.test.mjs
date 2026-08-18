// test/openloops.test.mjs — the list of unfinished work he actually reads.
//
// It listed one line per failed RUN, not per question. Asking the same thing
// four times because it keeps failing is one open loop; "can you fix studio
// locate" appeared twice in a seven-item list and "how much can you actually
// edit your own code" twice more. Five real items padded to seven, with the
// repeats pushing distinct ones off the end.
//
// findWork() in improve.mjs had exactly this bug and its fix comment reads
// "Five identical stack lines are one bug, not five."

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
const job = src.slice(src.indexOf('"open-loops"'), src.indexOf('"pre-event-brief"'));

// The collection loop, lifted from the source and run against real run text.
// The first version of this test asserted the SHAPE of the code — that a Map
// existed and the key template was present — and passed happily when the dedup
// was sabotaged to use a random key. A test of the shape is not a test of the
// behaviour.
// `resolved` is passed in rather than stubbed away, because suppressing a run
// the improve loop has already answered is now part of what this loop DOES —
// and the whole point of lifting the body is that the test runs the real thing.
function collect(runTexts, resolved = new Set()) {
  const body = job.slice(job.indexOf("const seen = new Map();"), job.indexOf("// Questions he was asked"));
  const fn = new Function("runs", "resolved", `
    const loops = [];
    ${body.replace("const runs = await recentRunFiles(24 * 7);", "")}
    return loops;
  `);
  return fn(runTexts.map((text, i) => ({ text, file: `run-${i}.md` })), resolved);
}

const failedRun = (title) => `---\nagent: cleetus\nstatus: failed\n---\n\n# ${title}\n`;

test("repeats collapse to one entry", () => {
  const out = collect([
    failedRun("can you fix studio locate"),
    failedRun("can you fix studio locate"),
    failedRun("search my obsidian vault for anything about breakouts"),
  ]);
  assert.strictEqual(out.length, 2, `expected 2 entries, got ${out.length}: ${out.join(" | ")}`);
  assert.ok(out.some((l) => /×2 · can you fix studio locate/.test(l)), out.join(" | "));
  assert.ok(out.some((l) => /· search my obsidian vault/.test(l)), out.join(" | "));
});

test("a question asked once carries no count", () => {
  const out = collect([failedRun("search my obsidian vault for anything about breakouts")]);
  assert.strictEqual(out.length, 1);
  assert.doesNotMatch(out[0], /×/, "a single failure should not be decorated with a count");
});

test("failed and unfinished are separate loops for the same question", () => {
  const unfinished = `---\nagent: cleetus\nstatus: done\n---\n\n# same question\n\n[Answered from partial information: all 40 tool calls were used]\n`;
  const out = collect([failedRun("same question"), unfinished]);
  assert.strictEqual(out.length, 2, `these are different states: ${out.join(" | ")}`);
});

test("the repeat count is kept, not discarded", () => {
  // Four failures of the same question is a stronger signal than one. Dropping
  // the count would trade one wrong impression for another.
  assert.match(job, /\$\{kind\}\$\{n > 1 \? ` ×\$\{n\}` : ""\}/);
});

test("both truncation markers count as unfinished", () => {
  // "Answered from partial information" was added after this job was written,
  // so a run that used every tool call and stopped short was being recorded as
  // a clean success and never appearing here.
  assert.match(job, /Stopped here after \\d\+ tool calls\|Answered from partial information/);
});

test("the improve loop's own builder run is a probe", () => {
  // It surfaced as "UNFINISHED · Fix exactly one thing in the Cleetus codebase"
  // in his open loops. askModel() in jobs.mjs was marked; this call goes
  // straight to ask() and was missed. Its 40-step budget makes it the run most
  // likely to look unfinished — exactly the one not to show him as his own.
  const imp = readFileSync(new URL("../src/improve.mjs", import.meta.url), "utf8");
  const call = imp.slice(imp.indexOf("const result = await ask({"), imp.indexOf("const changed = await changedFiles()"));
  assert.match(call, /probe: true/, "the builder call must mark itself");
});

test("dedup is by question AND kind, not by question alone", () => {
  // A question that failed once and later stopped short is two different
  // states, and collapsing them would hide one.
  assert.match(job, /`\$\{kind\}·\$\{title\}`/);
});

test("a run the improve loop has already answered drops off the list", () => {
  // Five items were on Grayson's worklist and one was open. The other four had
  // been re-run and answered by the improve loop days earlier, into a state file
  // that nothing read. A worklist that never shrinks stops being read.
  const out = collect(
    [failedRun("can you fix studio locate"), failedRun("what am I doing in this picture?")],
    new Set(["run-0.md"]),
  );
  assert.strictEqual(out.length, 1, `expected only the unresolved one: ${out.join(" | ")}`);
  assert.match(out[0], /what am I doing in this picture/);
});

test("suppression is keyed on the FILE, not the title", () => {
  // Titles repeat — "can you fix studio locate" was asked twice and each attempt
  // has its own run file. Resolving one must not silently clear the other.
  const out = collect(
    [failedRun("can you fix studio locate"), failedRun("can you fix studio locate")],
    new Set(["run-0.md"]),
  );
  assert.strictEqual(out.length, 1, out.join(" | "));
  assert.doesNotMatch(out[0], /×2/, "the surviving entry is a single attempt, not a pair");
});
