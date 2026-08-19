// src/selfreview.mjs — 04:00. What broke yesterday, what got fixed, what to fix next.
//
// WHAT GRAYSON ASKED FOR, in his words: "every day at 4am Cleetus analyzes all
// of the code and fixes issues that occurred over the previous day and he
// should also propose new fixes. That report should land in my morning brief."
//
// So this is three jobs wearing one name, and they are deliberately different
// in how much authority they have:
//
//   LOOK    gather what actually happened yesterday — failed jobs, failed runs,
//           health that went red, the day's commits. Evidence, not opinion.
//   FIX     hand that to improveOnce(), which already knows how to ship a change
//           to production and take it back if health drops. NOT reimplemented
//           here. There is exactly one autonomous pusher in this codebase and
//           adding a second — with its own guards, its own cap, its own idea of
//           what a baseline is — is how two loops end up reverting each other at
//           four in the morning.
//   PROPOSE read the code and write down what should change, WITHOUT changing
//           it. This is the half that gets to look at cleetusd itself, at the
//           iOS app, at anything: proposing is free, and the loop editing its
//           own revert path is not.
//
// WHY THE FIX PHASE HAS A CLOCK ON IT
// com.cleetus.improve uses StartInterval rather than StartCalendarInterval for a
// stated reason: launchd runs a missed calendar job the moment the Mac wakes,
// which would put an autonomous production push at whatever second the lid
// opens. This job IS a calendar job — Grayson asked for 4am and wants the report
// by 7 — so the same hazard is handled here instead: outside the small hours the
// review still runs and still reports, and the fix phase says it stood down
// rather than pushing code at 9:12am because the Mac woke up.
//
// WHY THE REPORT IS WRITTEN IN TWO PLACES
// ~/cleetus-memory/jobs/selfreview-<date>.md is the record, always written, and
// it is the one that survives the network being down. The row in Supabase is
// what /api/morning-brief reads three hours later. If the second write fails the
// job still succeeds and says so — a review nobody can see is a degraded result,
// not a failed one, and reporting it as failed would hide the day it genuinely
// could not look.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { CONFIG, secrets } from "./config.mjs";
import { improveOnce, STOP_FILE } from "./improve.mjs";
import { localStamp } from "./when.mjs";

const OUT = join(CONFIG.memoryRoot, "jobs");
const STATE = join(CONFIG.memoryRoot, "selfreview-state.json");

/* The code this loop is responsible for.
 *
 * `fixable` is the ONE repository improveOnce may push to. cleetusd is listed
 * and is deliberately not fixable: it holds the revert path, the health probe
 * and this file, so a bad autonomous change here is a change that can stop
 * itself being undone. It gets read, reviewed and written about like everything
 * else — it simply does not get edited unattended. */
export const REPOS = [
  { name: "cleetusv2", path: join(CONFIG.home, "cleetusv2"), scope: ".", fixable: true,
    what: "the cloud app, the Pages functions, /reach, and the iOS app under cleetus-ios" },
  // cleetusd has NO .git of its own. Its history lives in the repository at the
  // home directory itself, under the cleetusd/ prefix — so the working tree is
  // ~ and the pathspec is what makes the answer about cleetusd rather than about
  // every file Grayson owns. The first version of this pointed at ~/cleetusd,
  // found no .git, and reported "not a git working tree" for a repository with
  // a hundred commits in it.
  { name: "cleetusd", path: CONFIG.home, scope: "cleetusd", fixable: false,
    what: "the daemon on this Mac: the agent loop, the tools, the jobs, this reviewer" },
];

// How many changes the fix phase may ship in one night. improveOnce has its own
// daily cap (three) and this sits under it: the nightly pass is not entitled to
// spend the whole day's budget before Grayson is awake to see what it did.
const FIX_BUDGET = Number(process.env.CLEETUSD_NIGHTLY_FIXES || 2);

// The hours in which shipping unattended is what was asked for. Outside these,
// LOOK and PROPOSE still run; FIX stands down. Local hours, inclusive.
const SMALL_HOURS = [
  Number(process.env.CLEETUSD_NIGHTLY_FROM ?? 3),
  Number(process.env.CLEETUSD_NIGHTLY_TO ?? 6),
];

function sh(cmd, cwd, ms = 60_000) {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", cmd], { cwd, timeout: ms, killSignal: "SIGKILL", maxBuffer: 12_000_000 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || "").trim(),
        err: String(stderr || err?.message || "").trim(),
      }));
  });
}

const stampDay = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ── LOOK ──────────────────────────────────────────────────────────────────
   Everything below is evidence with a source attached. Nothing in here is the
   model's opinion, because the whole point of the fix phase is that it works on
   things that demonstrably happened.

   Every gatherer returns `{ items, blind }`. `blind` is not the same as empty
   and the difference is the entire reason the ten launch agents went unnoticed
   for three months: a job that cannot read its own log reporting "nothing
   failed" is worse than one that reports nothing at all. */

/** Jobs that failed in the window, out of the jobs log.
 *
 *  The path is a parameter so the parser can be tested against a log with known
 *  failures in it. It is not configuration — nothing passes anything but the
 *  default — and the reason it is here is that the first version of this parser
 *  grepped for a word the log does not contain, which no amount of running it
 *  against the real (currently clean) log would ever have revealed. */
export async function failedJobs(sinceMs, log = join(CONFIG.memoryRoot, "jobs.log")) {
  let text;
  try { text = await readFile(log, "utf8"); }
  catch (e) { return { items: [], blind: `cannot read ${log} (${e.code || e.message})` }; }

  // The exact shape jobHistory() parses, rather than a looser guess at it. The
  // word in that column is FAIL, not FAILED, and a grep for the longer one
  // matches nothing — a reviewer that reports "no jobs failed" every night
  // whatever happened is the same silent-green failure the jobs log exists to
  // end.
  const LINE = /^(\S+) (ok|FAIL)\s+(\S+) \(([\d.]+)s\) (.*)$/;
  const items = [];
  for (const line of text.trim().split("\n")) {
    const m = line.match(LINE);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (Number.isNaN(at) || at < sinceMs) continue;
    if (m[2] !== "FAIL") continue;
    items.push(`${m[3]}: ${m[5]}`.slice(0, 300));
  }
  return { items, blind: null };
}

/** Requests that did not complete cleanly. Probes excluded — a probe failing on
 *  purpose is a self-test, not a bug report. See findWork() in improve.mjs. */
export async function failedRuns(sinceMs) {
  const dir = join(CONFIG.memoryRoot, CONFIG.runsDir);
  let names;
  try { names = await readdir(dir); }
  catch (e) { return { items: [], blind: `cannot read the runs directory (${e.code || e.message}) — this is a blind night, not a quiet one` }; }

  const items = [];
  for (const f of names.filter((n) => n.endsWith(".md"))) {
    const p = join(dir, f);
    const s = await stat(p).catch(() => null);
    if (!s || s.mtimeMs < sinceMs) continue;
    const text = await readFile(p, "utf8").catch(() => "");
    if (/^probe:\s*true\s*$/m.test(text)) continue;
    if (!/^status:\s*failed\s*$/m.test(text) && !/FAILED `/.test(text)) continue;
    const title = (text.match(/^# (.+)$/m) || [])[1] || f;
    items.push(`${title} (${f})`);
  }
  return { items, blind: null };
}

/** Health checks that are failing right now, from the doctor. */
export async function failingChecks() {
  try {
    const d = await fetch("http://127.0.0.1:8767/doctor", { signal: AbortSignal.timeout(120_000) })
      .then((r) => r.json());
    return {
      // Named the way the check names itself, negated — "integrations healthy"
      // listed as a failure asserts the opposite of what it means.
      items: (d.failed || []).map((f) => `${f.area}: NOT TRUE that "${f.name}"` +
        (f.since ? ` (false since ${localStamp(f.since)})` : "")),
      blind: null,
    };
  } catch (e) {
    return { items: [], blind: `the doctor did not answer (${e.message})` };
  }
}

/** Errors the daemon logged in the window. */
export async function loggedErrors(sinceMs) {
  const log = join(CONFIG.home, "Library/Logs/cleetusd.err.log");
  let s, text;
  try {
    s = await stat(log);
    text = await readFile(log, "utf8");
  } catch (e) { return { items: [], blind: `cannot read ${log} (${e.code || e.message})` }; }

  // The file has no timestamps in it, so the only thing that can be said
  // honestly is whether it was WRITTEN in the window. Said that way rather than
  // presenting three-month-old stack lines as last night's news — which is the
  // mistake improve.mjs's log: keys make and can never clear.
  if (s.mtimeMs < sinceMs) return { items: [], blind: null };
  // A stack frame is not a bug report. "at process.processTicksAndRejections"
  // matched the old filter, appeared four times in six slots, and said nothing
  // about what went wrong — so the list that reaches the review was mostly
  // punctuation from errors whose actual message never made the cut.
  const lines = text.trim().split("\n")
    .filter((l) => /error|throw|unhandled|rejection/i.test(l))
    .filter((l) => !/^\s*at\s/.test(l));
  // Deduped: five copies of one stack line is one bug, and counting them
  // separately makes the list look five times longer than it is.
  const seen = new Set();
  const items = [];
  for (const l of lines.slice(-80).reverse()) {
    const key = l.replace(/\d+/g, "#").slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(l.trim().slice(0, 220));
    if (items.length >= 6) break;
  }
  return { items, blind: null };
}

/** What was committed yesterday, per repo. The diff the review actually reads. */
export async function yesterdaysCommits(since = "24 hours ago") {
  const out = [];
  for (const r of REPOS) {
    if (!existsSync(join(r.path, ".git"))) {
      out.push({ repo: r.name, blind: `${r.path} is not a git working tree`, commits: [], files: [] });
      continue;
    }
    const scope = r.scope && r.scope !== "." ? ` -- ${JSON.stringify(r.scope)}` : "";
    const log = await sh(`git log --since=${JSON.stringify(since)} --format='%h %s' --no-merges${scope}`, r.path);
    const files = await sh(`git log --since=${JSON.stringify(since)} --name-only --format= --no-merges${scope} | sort -u | head -60`, r.path);
    const dirty = await sh(`git status --porcelain${scope}`, r.path);
    out.push({
      repo: r.name,
      blind: log.ok ? null : `git log failed in ${r.path}: ${log.err.slice(0, 160)}`,
      commits: log.out ? log.out.split("\n").filter(Boolean) : [],
      files: files.out ? files.out.split("\n").filter(Boolean) : [],
      dirty: dirty.out ? dirty.out.split("\n").filter(Boolean).length : 0,
    });
  }
  return out;
}

/**
 * Everything that happened, in one object.
 *
 * Exported whole because the fix phase, the propose phase and the report all
 * read the same evidence, and gathering it three times would let them disagree
 * about what yesterday was.
 */
export async function yesterday({ hours = 24 } = {}) {
  const sinceMs = Date.now() - hours * 3_600_000;
  const [jobs, runs, checks, errors, commits] = await Promise.all([
    failedJobs(sinceMs),
    failedRuns(sinceMs),
    failingChecks(),
    loggedErrors(sinceMs),
    yesterdaysCommits(`${hours} hours ago`),
  ]);
  const blind = [jobs.blind, runs.blind, checks.blind, errors.blind, ...commits.map((c) => c.blind)]
    .filter(Boolean);
  return { sinceMs, jobs, runs, checks, errors, commits, blind };
}

/** One line per thing, for the model and for the report. */
export function evidenceText(e) {
  const block = (title, items, blind) => {
    if (blind) return `${title}: COULD NOT LOOK — ${blind}`;
    if (!items.length) return `${title}: none`;
    return `${title}:\n${items.map((i) => `  - ${i}`).join("\n")}`;
  };
  const parts = [
    block("Jobs that failed", e.jobs.items, e.jobs.blind),
    block("Requests that did not complete", e.runs.items, e.runs.blind),
    block("Health checks failing now", e.checks.items, e.checks.blind),
    block("Errors the daemon logged", e.errors.items, e.errors.blind),
  ];
  for (const c of e.commits) {
    if (c.blind) { parts.push(`Commits in ${c.repo}: COULD NOT LOOK — ${c.blind}`); continue; }
    parts.push(
      `Commits in ${c.repo} (${c.commits.length}${c.dirty ? `, ${c.dirty} uncommitted file(s) in the tree` : ""}):` +
      (c.commits.length ? `\n${c.commits.map((l) => `  - ${l}`).join("\n")}` : " none") +
      (c.files.length ? `\n  files touched: ${c.files.slice(0, 40).join(", ")}` : ""),
    );
  }
  return parts.join("\n\n");
}

/** Did anything actually go wrong, as opposed to nothing being readable? */
export function somethingBroke(e) {
  return e.jobs.items.length + e.runs.items.length + e.checks.items.length + e.errors.items.length > 0;
}

/* ── PROPOSE ───────────────────────────────────────────────────────────────
   The model reads the day's diff and the evidence and writes down what should
   change. It does not change anything, and it is told so plainly, because an
   agent that believes it is about to be judged on shipping will ship. */

/* What the review pass is allowed to touch.
 *
 * NOT a prompt instruction, because a prompt instruction does not hold. The
 * first live dry run was told, in its own brief, that it was not fixing anything
 * on this pass — and it called edit_file and wrote itself a morning brief at
 * ~/cleetus-memory/morning-brief-2026-08-19.md. On a DRY run. The wording
 * invited it ("you are writing the list he reads at 7am") and the model took the
 * invitation, exactly as the image agent took its refusal script: this file's
 * own history says prompt text loses that argument.
 *
 * So write_file, edit_file, save_skill, remember_fact, send_email, the keyring
 * writers and everything that moves a device are simply not on the list. The
 * answer IS the report; the caller writes it down.
 *
 * BE HONEST ABOUT run_shell. It is here because the review is worthless without
 * git log, grep and tail, and it can obviously write a file if it decides to.
 * What removing the file tools buys is not a guarantee, it is the absence of an
 * affordance: the model reached for edit_file because edit_file was there. A
 * shell that has to be talked into `cat > file` is a much longer road, and the
 * one time it was walked, it was not walked deliberately. */
export const REVIEW_TOOLS = [
  "read_file", "list_dir", "search_files", "find_files", "run_shell",
  "vault_read", "vault_search",
  "repo_status", "list_repos",
  "recall_chat", "read_chat", "recent_work",
  "health_report", "check_access", "scheduled_jobs",
  "read_security_skill", "find_security_skill",
];

const PROPOSAL_BRIEF = (evidence, diffs) => [
  "You are reviewing Grayson's own code overnight. Nobody is awake.",
  "",
  "YOUR ANSWER IS THE REPORT. Do not create a file, do not edit one, do not write a brief — the tools to",
  "do any of that are not on your list this pass, and something else assembles and delivers what you",
  "return. The only thing you produce is the text of your final answer.",
  "",
  "WHAT HAPPENED IN THE LAST DAY:",
  evidence,
  "",
  "WHAT CHANGED IN THE CODE:",
  diffs || "(no diff available)",
  "",
  "Use your tools to READ the files these touch before saying anything about them. A proposal about a",
  "file you did not open is a guess, and a confident guess is worse here than silence.",
  "",
  "YESTERDAY'S REVIEW IS NOT EVIDENCE. There are files named selfreview-<date>.md in",
  "~/cleetus-memory/jobs. Do not read them, and do not repeat what they said. Every one of their",
  "proposals is either already fixed or still broken, and the only way to tell is to open the file as",
  "it is NOW. On the second live run this job re-reported a plist defect it had found hours earlier and",
  "that had been fixed in between — a loop that reads its own output back has stopped reviewing the",
  "code and started reviewing itself.",
  "",
  "Write at most five proposals, best first. For each one, on its own line:",
  "  <file>:<line or function> — <what is wrong> — <what to do about it>",
  "",
  "Rules that decide whether this is worth reading:",
  "- Every proposal names a real file that exists. Check.",
  "- No refactors, no renaming, no 'consider adding tests' in general. One concrete change each.",
  "- Something that is failing because a credential expired, a service is down, or a device was never",
  "  registered is NOT a code proposal. Say what the underlying cause is and what a person has to do.",
  "- Never propose making a check pass by weakening what it asserts.",
  "- If yesterday was quiet and the code is fine, say exactly that in one line. An invented proposal",
  "  costs him more than an empty list: he will read it, open the file, and find nothing.",
  "",
  "Then, as the LAST line, write: HEADLINE: <one sentence under 120 characters summarising the night>.",
].join("\n");

/**
 * Split the model's answer into the headline and the body.
 *
 * The headline is what reaches his phone, so it is taken from a line the model
 * was told to write rather than by slicing the first sentence of a paragraph —
 * which is how the brief's push line used to end mid-word.
 */
export function splitHeadline(answer, fallback) {
  const text = String(answer || "").trim();
  // The leading `[*_#>\s]*` is not defensive programming, it is the second live
  // run. The model wrote its headline exactly as instructed and then bolded it:
  //
  //     **HEADLINE: Invalid plist XML, stale handoff tool list, ...**
  //
  // An anchor of `^\s*HEADLINE:` does not match that, so the whole thing fell
  // through to the fallback and the row published "0 fixes shipped overnight" —
  // technically true, and it threw away the one sentence the job exists to
  // produce. A model asked for prose will decorate the prose.
  const MARK = /^[*_#>\s]*HEADLINE:\s*(.+)$/im;
  const m = text.match(MARK);
  const headline = (m ? m[1] : "")
    .trim()
    // And the closing emphasis on the same line.
    .replace(/[*_`]+\s*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 150);
  const body = text.replace(/^[*_#>\s]*HEADLINE:.*$/im, "").trim();
  return { headline: headline || fallback, body: body || text };
}

/* ── PUBLISH ───────────────────────────────────────────────────────────────
   Straight to PostgREST with the service role key, the same way the Pages
   functions write. Not through /api/... on the site: this runs at 4am from the
   machine that holds the key, and a login round trip is one more thing that can
   be asleep. */

export async function publish(row) {
  const url = secrets.SUPABASE_URL;
  const key = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not in cleetus.env" };
  try {
    const r = await fetch(`${url}/rest/v1/code_reviews?on_conflict=date`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, reason: `${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ── The night ─────────────────────────────────────────────────────────────*/

async function loadState() {
  try { return JSON.parse(await readFile(STATE, "utf8")); } catch { return { nights: [] }; }
}
async function saveState(s) {
  await mkdir(CONFIG.memoryRoot, { recursive: true });
  s.nights = (s.nights || []).slice(-60);
  await writeFile(STATE, JSON.stringify(s, null, 2), "utf8");
}

/**
 * How long the review pass may run, given what the night has already spent.
 *
 * A fixed 75 minutes is right when the review is the only thing that happens.
 * It is not right after the fix phase: improveOnce can spend forty minutes on a
 * builder pass, ten more waiting for a Cloudflare deploy, and it may do that
 * twice. 04:00 + two fixes + 75 minutes lands at about 06:35 on a bad night,
 * and 07:03 is when the brief composes and reads whatever row exists.
 *
 * So the bound is a TIME OF DAY, not a duration: be finished by 06:30, and take
 * the shorter of that and the cap. The floor exists because a job that starts
 * late — the Mac woke at 06:20 — should still produce a short review rather
 * than a zero-millisecond deadline, which ask() reads as "no deadline at all"
 * and would run for two hours.
 */
export function reviewDeadlineMs(now = new Date(), {
  capMs = Number(process.env.CLEETUSD_REVIEW_DEADLINE_MS || 75 * 60_000),
  byHour = Number(process.env.CLEETUSD_REVIEW_BY_HOUR ?? 6),
  byMinute = 30,
  floorMs = 15 * 60_000,
} = {}) {
  const due = new Date(now);
  due.setHours(byHour, byMinute, 0, 0);
  const left = due.getTime() - now.getTime();
  if (left <= 0) return floorMs;
  return Math.max(floorMs, Math.min(capMs, left));
}

/** Is it the hour this is allowed to ship in? */
export function inSmallHours(now = new Date(), [from, to] = SMALL_HOURS) {
  const h = now.getHours();
  return h >= from && h <= to;
}

/**
 * One night's review.
 *
 * `dry` does everything except ship and except write to Supabase. It is the way
 * to see what tonight would say without waiting for tonight, and it must never
 * be the thing that pushes code — see improveOnce, whose --dry moved the branch
 * to main for a while before anyone noticed.
 */
export async function reviewOnce({ dry = false, now = new Date(), hours = 24 } = {}) {
  const day = stampDay(now);
  const evidence = await yesterday({ hours });
  const text = evidenceText(evidence);

  // ── FIX ──
  const fixes = [];
  let fixNote = "";
  const canShip = inSmallHours(now);
  if (dry) {
    fixNote = "dry run — nothing was shipped";
  } else if (existsSync(STOP_FILE)) {
    fixNote = `the STOP file is present (${STOP_FILE}), so nothing was shipped`;
  } else if (!canShip) {
    // The Mac was asleep at four and launchd ran this on wake. Reviewing then is
    // useful; pushing to production at whatever second the lid opened is the
    // exact thing com.cleetus.improve's plist is written to avoid.
    fixNote = `it is ${localStamp(now.toISOString())}, outside the ${SMALL_HOURS[0]}:00–${SMALL_HOURS[1]}:59 window — ` +
              "reviewed and proposed, shipped nothing (this job runs on a calendar and launchd fires a missed one on wake)";
  } else if (!somethingBroke(evidence)) {
    fixNote = "nothing broke yesterday, so there was nothing to fix";
  } else {
    for (let i = 0; i < FIX_BUDGET; i++) {
      const r = await improveOnce({}).catch((e) => ({ outcome: "the fix pass threw", why: String(e.message || e) }));
      fixes.push(r);
      // improveOnce reports a skip when it is blocked and an outcome when it
      // did something. Either way, once it has nothing left to work on there is
      // no point asking it a second time.
      if (r.skipped || r.outcome === "no change made") break;
    }
    fixNote = fixes.length ? "" : "the fix pass found nothing it could work on";
  }

  // ── PROPOSE ──
  // The diff is capped hard. A day with a big merge in it would otherwise send
  // a megabyte of patch into a 262k window and push the evidence — the part
  // that matters — out of the top of it.
  const diffs = [];
  for (const r of REPOS) {
    if (!existsSync(join(r.path, ".git"))) continue;
    const scope = r.scope && r.scope !== "." ? ` -- ${JSON.stringify(r.scope)}` : "";
    const d = await sh(`git log --since='${hours} hours ago' --stat --format='%h %s' --no-merges${scope}`, r.path);
    if (d.out) diffs.push(`### ${r.name} — ${r.what}\n${d.out.slice(0, 6000)}`);
  }

  const { ask } = await import("./agent.mjs");
  let answer = "";
  try {
    const out = await ask({
      history: [{ role: "user", content: PROPOSAL_BRIEF(text, diffs.join("\n\n")) }],
      agent: "builder",
      // Reading is most of this. A budget that covers the reading and not the
      // writing produces a review that describes the codebase back.
      maxSteps: Number(process.env.CLEETUSD_REVIEW_STEPS || 40),
      // Reading and grepping only. See REVIEW_TOOLS: the first live run wrote
      // itself a file despite being told not to, on a dry pass.
      tools: REVIEW_TOOLS,
      // A wall-clock bound, unlike every other unattended job here, and for a
      // reason specific to this one: the report has to EXIST by 07:03, when the
      // brief is composed. Nobody is waiting at 4am, but something is due at 7.
      //
      // Measured on the first live run: 84 tool calls and still going. ask()
      // grows its own budget to a ceiling of 120 while the model keeps reaching
      // for tools, and 120 steps at thirty to sixty seconds each is ninety
      // minutes to two hours. Taken from the clock rather than from a stopwatch
      // started here, so the time the fix phase already spent comes out of it.
      deadlineMs: reviewDeadlineMs(new Date()),
      // The system reviewing itself is not a request Grayson made. Without this
      // the review lands in his open loops and in tomorrow's digest as his own
      // unfinished work — which is exactly how brain-analysis started reading
      // its own questions back as his.
      probe: true,
    });
    answer = out.answer || "";
  } catch (e) {
    answer = `The review pass could not run: ${e.message}`;
  }

  const shipped = fixes.filter((f) => f && /^shipped/.test(String(f.outcome || ""))).length;
  const reverted = fixes.filter((f) => f && /revert/i.test(String(f.outcome || ""))).length;
  const fallback =
    `${shipped} fix${shipped === 1 ? "" : "es"} shipped overnight` +
    (reverted ? `, ${reverted} reverted` : "") +
    (evidence.blind.length ? `, ${evidence.blind.length} thing(s) could not be checked` : "");
  const { headline, body } = splitHeadline(answer, fallback);

  // ── The record on disk, which is always written ──
  const report = [
    `# Overnight review ${day}`,
    "",
    `_${localStamp(now.toISOString())}_`,
    "",
    "## What happened yesterday",
    "",
    text,
    "",
    "## What was fixed",
    "",
    fixNote
      ? fixNote
      : fixes.map((f, i) =>
          `${i + 1}. ${f.outcome || f.skipped || "no outcome recorded"}` +
          (f.issue ? `\n   issue: ${f.issue}` : "") +
          (f.sha ? `\n   commit: ${f.sha}` : "") +
          (f.why ? `\n   reverted because: ${f.why}` : "")).join("\n"),
    "",
    "## What should be fixed next",
    "",
    body || "(the review produced nothing)",
    "",
    evidence.blind.length
      ? `## What could NOT be checked\n\n${evidence.blind.map((b) => `- ${b}`).join("\n")}\n`
      : "",
  ].join("\n");

  await mkdir(OUT, { recursive: true });
  const path = join(OUT, `selfreview-${day}.md`);
  await writeFile(path, report, "utf8");
  // A stable name as well as the dated one, so anything reading "the latest
  // review" does not have to know what today is.
  await writeFile(join(OUT, "selfreview.md"), report, "utf8").catch(() => {});

  // ── The copy the brief reads ──
  let published = { ok: false, reason: "dry run" };
  if (!dry) {
    published = await publish({
      date: day,
      headline,
      report: body || answer,
      fixed: shipped,
      reverted,
      blind: evidence.blind.length,
      broke: somethingBroke(evidence),
    });
  }

  const state = await loadState();
  state.nights.push({ at: now.toISOString(), day, shipped, reverted, headline, published: published.ok });
  await saveState(state);

  const summary =
    `${headline}` +
    (published.ok ? "" : ` (not published to the brief: ${published.reason})`);

  return {
    ok: true, day, path, headline, report: body, fixes, fixNote,
    published, blind: evidence.blind, shipped, reverted, summary,
  };
}
