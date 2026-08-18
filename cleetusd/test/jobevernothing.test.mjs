// test/jobevernothing.test.mjs — a job that has never once done anything.
//
// jobs.mjs names this failure in its own header: "a job that reports 'nothing to
// do' when it actually could not look would be the same bug in a new costume."
// It was right, and nothing checked for it.
//
// pre-event-brief ran 152 times and 151 of those said "nothing starting in the
// next 45 minutes" — which is also exactly what a correct run says on a quiet
// evening. The single exception is the brief it produced after the parse bug was
// fixed this morning. Before that: 151 out of 151.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");

// The rule, lifted rather than restated.
function judge(runs, { minRuns = 20 } = {}) {
  const byJob = new Map();
  for (const [job, summary] of runs) {
    const e = byJob.get(job) || { runs: 0, empty: 0 };
    e.runs++;
    if (/^(nothing|no |none|0 |not )/i.test(summary)) e.empty++;
    byJob.set(job, e);
  }
  return [...byJob].filter(([, e]) => e.runs >= minRuns && e.empty === e.runs).map(([j]) => j);
}

const many = (job, summary, n) => Array.from({ length: n }, () => [job, summary]);

test("it catches the real historical case", () => {
  // pre-event-brief as it actually stood: every run, no result.
  const flagged = judge(many("pre-event-brief", "nothing starting in the next 45 minutes", 151));
  assert.deepStrictEqual(flagged, ["pre-event-brief"]);
});

test("one success is enough to clear it", () => {
  // The state after the fix. The job is quiet most evenings and that is correct.
  const runs = [...many("pre-event-brief", "nothing starting in the next 45 minutes", 151),
                ["pre-event-brief", 'briefed "Choir loft worship night"']];
  assert.deepStrictEqual(judge(runs), []);
});

test("a genuinely quiet job is not flagged", () => {
  // text-monitor: 144 quiet runs, 3 real ones. Quiet is not broken, and a check
  // that cannot tell the difference would be switched off within a week.
  const runs = [...many("text-monitor", "no new texts", 144), ...many("text-monitor", "4 incoming text(s)", 3)];
  assert.deepStrictEqual(judge(runs), []);
});

test("a young job is not accused", () => {
  // Everything looks like it has never worked on its first few runs.
  assert.deepStrictEqual(judge(many("brand-new", "nothing to do", 5)), []);
});

test("the check reports the quietest job even when green", () => {
  // Without this the panel says only "ok" and the trend towards a silent job is
  // invisible until it is total.
  assert.match(src, /quietest is \$\{worst\[0\]\}/);
  assert.match(src, /it may be unable to see its input/);
});

test("the fix line points at the input, not the exit code", () => {
  // The whole class is jobs that exit 0 while seeing nothing.
  assert.match(src, /check what its INPUT looks like, not whether it exits 0/);
});
