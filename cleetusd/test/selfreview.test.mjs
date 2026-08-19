// test/selfreview.test.mjs — the 04:00 review, and the three ways it could lie.
//
// The job reports to Grayson's phone at 7am, which makes it the most dangerous
// kind of job in this codebase: he reads it, believes it, and does not check.
// Every test here is about a sentence it could produce that would be wrong.
//
//   1. "no jobs failed" when it was reading the wrong word out of the log
//   2. "nothing to report" when it could not read its inputs at all
//   3. an autonomous production push at 09:12 because the Mac woke up late
//
// The first was a real bug in the first draft: the jobs log writes FAIL, the
// gatherer grepped for FAILED, and it matched nothing — a reviewer that reports
// a clean night every night, whatever happened.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { splitHeadline, inSmallHours, evidenceText, somethingBroke, failedJobs, REPOS } from "../src/selfreview.mjs";

const src = readFileSync(new URL("../src/selfreview.mjs", import.meta.url), "utf8");

test("the jobs log is parsed for the word it actually contains", () => {
  // bin/job.mjs writes `<iso> ok|FAIL  <id> (<s>s) <summary>`. FAIL, not FAILED.
  // Grepping for the longer word matches nothing and the review reports a clean
  // night forever — green because it is blind, which is the exact failure mode
  // jobs.mjs was written to end.
  assert.match(src, /\(ok\|FAIL\)/, "must match the FAIL token the log really writes");
  assert.doesNotMatch(src, /\\bFAILED\\b/, "nothing should be looking for FAILED in the jobs log");
});

test("could-not-look never renders as nothing-wrong", () => {
  const blind = {
    jobs: { items: [], blind: "cannot read jobs.log (ENOENT)" },
    runs: { items: [], blind: null },
    checks: { items: [], blind: null },
    errors: { items: [], blind: null },
    commits: [],
  };
  const text = evidenceText(blind);
  assert.match(text, /COULD NOT LOOK/);
  assert.doesNotMatch(text.split("\n")[0], /: none/,
    "a log it could not open must not be reported as an empty log");

  const quiet = {
    jobs: { items: [], blind: null },
    runs: { items: [], blind: null },
    checks: { items: [], blind: null },
    errors: { items: [], blind: null },
    commits: [],
  };
  assert.match(evidenceText(quiet), /Jobs that failed: none/);
  // And the two must be distinguishable by the caller, not only by a human
  // reading prose: somethingBroke() decides whether the fix phase runs at all.
  assert.strictEqual(somethingBroke(quiet), false);
});

test("the fix phase only ships in the hours it was asked to", () => {
  // launchd runs a missed StartCalendarInterval job the moment the Mac wakes.
  // com.cleetus.improve avoids that by not being a calendar job at all; this one
  // has to be one, because the report must exist before the 7am brief. So the
  // window is enforced in code instead.
  const at = (h) => { const d = new Date(2026, 7, 19, h, 30); return d; };
  assert.ok(inSmallHours(at(4)), "04:30 is the whole point of the job");
  assert.ok(inSmallHours(at(3)), "the window is inclusive at the bottom");
  assert.ok(inSmallHours(at(6)), "and at the top");
  assert.ok(!inSmallHours(at(9)), "09:30 is a lid opening, not four in the morning");
  assert.ok(!inSmallHours(at(2)), "02:30 is before the window");
  assert.ok(!inSmallHours(at(22)), "and the evening is not it either");
});

test("the headline is taken from the line the model was told to write", () => {
  // Not by slicing the first sentence off a paragraph, which is how a push line
  // ends mid-word.
  const { headline, body } = splitHeadline(
    "src/foo.mjs:12 — leaks a handle — close it in the finally\n\nHEADLINE: One fix shipped, one proposal for the flight tracker.",
    "fallback",
  );
  assert.strictEqual(headline, "One fix shipped, one proposal for the flight tracker.");
  assert.doesNotMatch(body, /HEADLINE:/, "the marker must not survive into the report");
  assert.match(body, /src\/foo\.mjs/);

  // A model that ignored the instruction must not produce an empty headline —
  // that is the field the brief and the notification are composed from.
  assert.strictEqual(splitHeadline("just some prose", "2 fixes shipped").headline, "2 fixes shipped");
  assert.strictEqual(splitHeadline("", "nothing happened").headline, "nothing happened");

  // And it has to fit a push notification.
  const long = splitHeadline(`HEADLINE: ${"x".repeat(400)}`, "fb");
  assert.ok(long.headline.length <= 150, `headline was ${long.headline.length} characters`);
});

test("cleetusd is reviewed but never edited unattended", () => {
  const d = REPOS.find((r) => r.name === "cleetusd");
  const v2 = REPOS.find((r) => r.name === "cleetusv2");
  assert.ok(d && v2);
  // It holds the revert path, the health probe and the reviewer itself. A bad
  // autonomous change here is a change that can stop itself being undone.
  assert.strictEqual(d.fixable, false);
  assert.strictEqual(v2.fixable, true);
  // cleetusd has no .git of its own — its history is in the repository at the
  // home directory, under the cleetusd/ prefix. Pointed at ~/cleetusd it found
  // no working tree and reported a repo with a hundred commits as unreadable.
  assert.strictEqual(d.scope, "cleetusd");
  assert.ok(!d.path.endsWith("/cleetusd"), "the working tree is the home repo, not the subdirectory");
});

test("there is exactly one autonomous pusher, and this is not it", () => {
  // Two loops pushing to the same branch with two different ideas of what a
  // baseline is would spend the small hours reverting each other.
  assert.match(src, /import \{ improveOnce, STOP_FILE \} from "\.\/improve\.mjs"/);
  for (const forbidden of [/git push/, /git commit/, /git revert/]) {
    assert.doesNotMatch(src, forbidden,
      "the review must delegate shipping to improveOnce, never do it itself");
  }
  // And the improve loop's own off switch has to stop this one shipping too.
  assert.match(src, /existsSync\(STOP_FILE\)/);
});

test("a night that could not publish is still a night that happened", async () => {
  // The report on disk is written before the network is touched, so an outage
  // costs the brief its section and costs the record nothing.
  const write = src.indexOf('await writeFile(path, report, "utf8")');
  const publish = src.indexOf("published = await publish(");
  assert.ok(write > 0 && publish > 0);
  assert.ok(write < publish, "the disk record must be written before the publish is attempted");
});

test("failedJobs reads a real log and respects the window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "selfreview-"));
  await mkdir(dir, { recursive: true });
  const log = join(dir, "jobs.log");
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  await writeFile(log, [
    `${iso(90 * 3600_000)} FAIL briefing (2.0s) ancient failure, outside the window`,
    `${iso(2 * 3600_000)} ok   heartbeat (1.0s) nothing to flag`,
    `${iso(3 * 3600_000)} FAIL flights (4.0s) the tracker did not answer`,
    "a line that is not a job line at all",
  ].join("\n"), "utf8");

  const out = await failedJobs(now - 24 * 3600_000, log);
  assert.strictEqual(out.blind, null);
  assert.deepStrictEqual(out.items, ["flights: the tracker did not answer"]);
});

test("the review pass cannot write, because being told not to did not hold", async () => {
  // The first live dry run was told plainly that it was not fixing anything on
  // this pass. It called edit_file and wrote itself a morning brief at
  // ~/cleetus-memory/morning-brief-2026-08-19.md. On a DRY run. The same lesson
  // as the image agent's refusal, from the other direction: prompt text does not
  // win an argument with the weights, and the fix is the tool list.
  const { REVIEW_TOOLS } = await import("../src/selfreview.mjs");
  const { TOOLS } = await import("../src/tools/index.mjs");

  for (const name of REVIEW_TOOLS) {
    assert.ok(TOOLS[name], `REVIEW_TOOLS names ${name}, which is not a tool — it would be silently dropped`);
  }
  for (const writer of ["write_file", "edit_file", "save_skill", "remember_fact",
                        "send_email", "save_secret", "forget_secret", "get_secret",
                        "web_act", "desk_light", "clone_repo", "learn_face"]) {
    assert.ok(!REVIEW_TOOLS.includes(writer), `${writer} must not be offered to the review pass`);
  }
  // And the allowlist has to actually be handed to ask(), not merely declared.
  assert.match(src, /tools: REVIEW_TOOLS/);

  // run_shell IS on the list and can obviously write. That is a stated trade,
  // not an oversight: without git and grep the review is worthless. The comment
  // saying so is load-bearing — the next person to read this list will ask.
  assert.ok(REVIEW_TOOLS.includes("run_shell"));
  assert.match(src, /BE HONEST ABOUT run_shell/);
});

test("the review is bounded by the clock, not only by the step budget", async () => {
  // Every other unattended job here passes deadlineMs: 0 and is right to. This
  // one is due at 07:03: the brief composes then and reads whatever row exists.
  // Measured on the first live run — 84 tool calls and still climbing toward
  // ask()'s ceiling of 120, which at thirty to sixty seconds a step is up to two
  // hours from a 04:00 start.
  assert.doesNotMatch(src, /deadlineMs: 0/, "an unbounded review can miss the brief it exists to feed");

  const { reviewDeadlineMs } = await import("../src/selfreview.mjs");
  const at = (h, m) => new Date(2026, 7, 19, h, m);
  const mins = (d) => Math.round(reviewDeadlineMs(d) / 60_000);

  // A normal 04:00 start gets the full cap and still finishes long before the
  // brief.
  assert.strictEqual(mins(at(4, 0)), 75);
  assert.ok(4 * 60 + 75 < 6 * 60 + 30, "the cap itself must land before the cutoff");

  // The bound is a TIME OF DAY, so whatever the fix phase spent comes out of it.
  // improveOnce can burn forty minutes on a builder pass plus ten waiting for a
  // Cloudflare deploy, twice; a stopwatch started here would not know that.
  assert.strictEqual(mins(at(6, 0)), 30, "an hour of fixing must shorten the review, not delay the brief");
  assert.ok(mins(at(6, 20)) <= 15);

  // Never zero. ask() reads deadlineMs: 0 as "no deadline at all", so a job that
  // started after the cutoff would run for two hours — the exact opposite of
  // what a late start should do.
  for (const h of [6, 7, 9, 23]) {
    assert.ok(reviewDeadlineMs(at(h, 45)) > 0, `${h}:45 produced a zero deadline`);
    assert.ok(mins(at(h, 45)) >= 15, `${h}:45 left no time to say anything at all`);
  }
});
