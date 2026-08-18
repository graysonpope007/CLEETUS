// test/consolidation.test.mjs — what is allowed to reach MEMORY.md unattended.
//
// nightly-consolidation runs at 23:00 and calls remember() on whatever the model
// returns. MEMORY.md is read by every agent on every message and nothing
// downstream ever removes a line, so this is the highest-consequence unattended
// write in the system: wrong entries do not decay, they compound.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
const job = src.slice(src.indexOf('"nightly-consolidation"'), src.indexOf('"vault-sync"'));

test("a job asking the model marks itself as a probe", () => {
  // Otherwise the loop closes on itself: this job's own question — the whole
  // day's digest pasted into a prompt — becomes one of tomorrow's runs and is
  // read back as something Grayson said. brain-analysis did exactly that, and
  // its run had to be marked by hand afterwards.
  assert.match(src, /async function askModel\(question, agent\) \{[\s\S]{0,300}?probe: true/,
    "askModel must pass probe: true to ask()");
});

test("the number of facts promoted in one night is bounded", () => {
  assert.match(job, /const MAX_FACTS = \d+/, "there must be a cap at all");
  const n = Number(job.match(/const MAX_FACTS = (\d+)/)[1]);
  assert.ok(n > 0 && n <= 25, `${n} is not a sane nightly ceiling`);
  assert.match(job, /candidates\.slice\(0, MAX_FACTS\)/);
});

test("only the kept facts are remembered, never the dropped ones", () => {
  // The failure that would make the cap pointless: slicing for the report but
  // still calling remember() over the full list.
  assert.match(job, /for \(const f of facts\) await remember\(/);
  assert.doesNotMatch(job, /for \(const f of candidates\) await remember\(/);
});

test("what was dropped is written down, not swallowed", () => {
  // A silent cap reads as "that was everything worth keeping", which is the one
  // thing it is not.
  assert.match(job, /NOT remembered/);
  assert.match(job, /dropped\.length \? ` — \$\{dropped\.length\} over the \$\{MAX_FACTS\} cap/);
});

test("nothing durable means nothing written", () => {
  // The model answering NOTHING must return before remember() is reached. Run
  // live against 43 real runs: MEMORY.md was byte-identical afterwards.
  const guard = job.indexOf("NOTHING\\s*$");
  const firstRemember = job.indexOf("await remember(");
  assert.ok(guard > 0 && guard < firstRemember, "the NOTHING check must come first");
  assert.match(job, /return \{ ok: true, summary: `\$\{runs\.length\} runs, nothing durable` \}/);
});

test("the day's runs are read through the probe-filtered reader", () => {
  assert.match(job, /await recentRunFiles\(24\)/);
  assert.match(src, /if \(!includeProbes && \/\^probe:\\s\*true\\s\*\$\/m\.test\(text\)\) continue;/,
    "recentRunFiles must exclude probes or this job consumes its own test traffic");
});

test("the escape hatch comes last and costs something", () => {
  // The prompt used to end "If there is nothing durable, reply with exactly:
  // NOTHING", and the model took that exit. Measured against a digest holding
  // two unmissable facts — a bass swap and a protein target change — the old
  // wording extracted on 1 run in 7; this one on 4 in 4. The job had been
  // running nightly, reporting "ok, nothing durable", and promoting nothing.
  assert.doesNotMatch(job, /If there is nothing durable, reply with exactly/,
    "the easy get-out is back and the job will stop finding anything");
  assert.match(job, /Read every line above and find the places where Grayson states/);
  assert.match(job, /If and only if you have read it all/);
  // The demand for work must precede the permission to decline it.
  assert.ok(job.indexOf("Read every line above") < job.indexOf("If and only if"),
    "the escape hatch must come after the instruction, not before");
});

test("two facts returned in one paragraph become two lines", () => {
  // "One per line" is an instruction, not a guarantee: on one run in three the
  // model returned both facts as a sentence pair, which would be one long
  // unsearchable line in MEMORY.md forever.
  assert.match(job, /\.flatMap\(\(l\) => l\.split\(\/\(\?<=\[\.!\?\]\)\\s\+\(\?=\[A-Z\]\)\/\)\)/,
    "the sentence split should be applied to every returned line");
});

test("the split leaves numbers and filenames alone", () => {
  // Same rule as endsOnAPromise: a full stop only ends a sentence when a
  // capital follows. "170g." and "health.js" must survive intact.
  const split = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/);
  assert.deepStrictEqual(
    split("Grayson dropped his target to 170g. Grayson switched to a StingRay."),
    ["Grayson dropped his target to 170g.", "Grayson switched to a StingRay."]);
  assert.deepStrictEqual(split("He edited health.js today."), ["He edited health.js today."]);
});
