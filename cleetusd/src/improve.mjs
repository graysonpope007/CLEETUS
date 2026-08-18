// src/improve.mjs — Cleetus fixing Cleetus, unattended.
//
// Grayson chose full auto to main with revert on red, over a preview-first
// flow. So this pushes real code to production without asking. Everything
// below exists because of that choice.
//
// THE SHAPE
//   1. Look for something actually wrong. Never invent work.
//   2. Record health BEFORE touching anything. This is the yardstick; without
//      a baseline "is it broken now" has no answer.
//   3. Let the builder agent fix ONE thing.
//   4. Gates: node --check, esbuild the changed functions, vite build. A
//      broken build has already saved this project from one bad deploy.
//   5. Commit, push, wait for the Pages deploy to actually finish.
//   6. Compare health to the baseline. Worse -> git revert, push, verify the
//      revert deployed too.
//
// WHAT IT WILL NOT DO, and why each one is load-bearing:
//   - Run on a dirty tree. Grayson's uncommitted work is not the loop's to
//     ship, and `git revert` would take his changes with it.
//   - Run if cloud health is UNREACHABLE. Not merely red: regressed() counts
//     only failures that are new since the baseline, so it works fine with
//     things already broken. But if health cannot be measured at all, "after"
//     is unmeasurable too and real damage would read as clean.
//   - Touch its own files. A loop that edits its revert path can put itself
//     somewhere it cannot get back from.
//   - Exceed a daily cap, or run at all while a STOP file exists.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "./config.mjs";
import { ask, endsOnAPromise } from "./agent.mjs";
import { saveSkill, slugify } from "./memory.mjs";

const run = promisify(execFile);
const REPO = join(CONFIG.home, "cleetusv2");
const STATE = join(CONFIG.memoryRoot, "improve-state.json");
export const STOP_FILE = join(CONFIG.memoryRoot, "STOP-IMPROVING");

const DAILY_CAP = Number(process.env.CLEETUSD_IMPROVE_CAP || 3);

// Files the loop may never edit. Its own machinery, and anything holding keys.
const OFF_LIMITS = [/^src\/improve\.mjs$/, /^bin\/improve\.mjs$/, /\.env/, /cleetus\.env/];

const sh = (cmd, cwd = REPO) => run("/bin/zsh", ["-lc", cmd], { cwd, timeout: 300_000, maxBuffer: 10_000_000 });

function log(...a) { console.error("[improve]", ...a); }

// ── State ───────────────────────────────────────────────────────────────────

async function loadState() {
  try { return JSON.parse(await readFile(STATE, "utf8")); } catch { return { day: "", count: 0, history: [] }; }
}
async function saveState(s) {
  await mkdir(CONFIG.memoryRoot, { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2), "utf8");
}
const today = () => new Date().toISOString().slice(0, 10);

// ── Health, the yardstick ───────────────────────────────────────────────────

async function cloudHealth() {
  try {
    const { cookie } = await session();
    const r = await fetch(`${CONFIG.cloud}/api/health`, {
      headers: { Cookie: cookie }, signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json();
    return { ok: !!j.ok, down: j.down || [], checks: j.checks || {} };
  } catch (e) {
    return { ok: false, down: ["unreachable"], error: e.message };
  }
}

let _cookie = null;
async function session() {
  if (_cookie) return { cookie: _cookie };
  const r = await fetch(`${CONFIG.cloud}/api/session/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: CONFIG.cloud },
    body: JSON.stringify({ password: CONFIG.sitePassword }),
  });
  const sc = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).filter((c) => c.startsWith("cleetus_session="));
  if (!sc.length) throw new Error("cloud login failed");
  _cookie = sc.join("; ");
  return { cookie: _cookie };
}

/** Strictly worse than baseline. New failures only — pre-existing ones do not count. */
function regressed(before, after) {
  if (!after.ok && before.ok) return "overall health went red";
  const was = new Set(before.down || []);
  const now = (after.down || []).filter((d) => !was.has(d));
  return now.length ? `new failures: ${now.join(", ")}` : null;
}

// ── Finding something genuinely wrong ───────────────────────────────────────

/**
 * Which integrations were already failing at the previous health reading.
 *
 * The doctor writes one line every fifteen minutes, and the cloud integrations
 * appear inside `integrations-healthy[...]`. Reading the last such line gives
 * the reading before this one.
 *
 * Returns null when it cannot tell — an unreadable or empty log must not
 * silently suppress every issue. Not knowing is a reason to proceed, not a
 * reason to drop work on the floor.
 */
async function previouslyDown() {
  try {
    const text = await readFile(join(CONFIG.home, "Library/Logs/cleetus-health.log"), "utf8");
    const lines = text.trim().split("\n").filter((l) => l.includes("integrations-healthy["));
    if (!lines.length) return null;
    const names = lines[lines.length - 1].match(/integrations-healthy\[([^\]]*)\]/);
    return names ? new Set(names[1].split(",").map((n) => n.trim()).filter(Boolean)) : null;
  } catch {
    return null;
  }
}

/**
 * Has a health check been GREEN at any point since we last tried to fix it?
 *
 * Attempts are retired permanently, which is what makes the loop converge — a
 * run file that recorded a failure keeps that record forever, so without this
 * the same dead bug stays top-ranked every day. The cost is blindness: if
 * outlook is fixed by hand and later breaks again for a real reason in the
 * code, the loop can never look at it.
 *
 * Recovery is what separates the two. A check that has gone green since the
 * attempt and is red again is a NEW failure, not a retry of the old one. A
 * check that has never recovered — outlook, push, both waiting on a human — has
 * not become newly interesting and stays retired.
 *
 * Reads the doctor's health log, which is the only record of what was true
 * between then and now.
 */
async function recoveredSince(name, sinceIso) {
  if (!name || !sinceIso) return false;
  const at = Date.parse(sinceIso);
  if (Number.isNaN(at)) return false;
  try {
    const text = await readFile(join(CONFIG.home, "Library/Logs/cleetus-health.log"), "utf8");
    for (const line of text.trim().split("\n")) {
      const when = Date.parse((line.match(/^(\S+)/) || [])[1] || "");
      if (Number.isNaN(when) || when <= at) continue;
      const m = line.match(/integrations-healthy\[([^\]]*)\]/);
      // No integrations line at all means every integration was healthy then.
      const down = m ? new Set(m[1].split(",").map((x) => x.trim())) : new Set();
      if (!down.has(name)) return true;
    }
  } catch { /* no log: cannot show recovery, so stay retired */ }
  return false;
}

async function findWork(health) {
  const issues = [];

  // A single reading is not an outage.
  //
  // Measured over 64 health readings: outlook was down in 59 of them and never
  // once as an isolated blip; push the same. plaid was down in 16 readings and
  // SEVEN of those were single readings with a healthy one either side — 44% of
  // its failures are flaps. `google` appeared in a failure list and was gone
  // half an hour later, reporting "connected, 20 events".
  //
  // The loop reads one snapshot, so a flap looks identical to an outage. It
  // would then spend a whole cycle — and one of three daily slots — writing a
  // fix for an integration that was never broken, against a symptom it cannot
  // reproduce. Requiring the previous reading to agree costs at most fifteen
  // minutes of delay on a real outage, which has already lasted hours by then.
  const alsoDownBefore = await previouslyDown();
  for (const name of health.down || []) {
    if (alsoDownBefore && !alsoDownBefore.has(name)) {
      log(`skipping ${name}: down in this reading only, not the previous one`);
      continue;
    }
    issues.push({ kind: "health", key: `health:${name}`, what: `/api/health reports ${name} is down`, hint: `Look at functions/api/${name}*.js and _lib/${name}.js.` });
  }

  // Runs that ended in an error are the most honest bug reports available:
  // a real request that really failed, with its tool trace attached.
  try {
    const runsDir = join(CONFIG.memoryRoot, CONFIG.runsDir);
    const files = (await readdir(runsDir)).filter((f) => f.endsWith(".md")).sort().slice(-40);
    for (const f of files) {
      const path = join(runsDir, f);
      const text = await readFile(path, "utf8");

      // A probe's failure means nothing to this loop.
      //
      // Probes are the system testing itself, and some of them fail ON PURPOSE:
      // the keyring probe asks Cleetus to print a secret and counts a refusal as
      // success. Handed that as a bug report, the loop would set out to fix the
      // refusal. Others are adversarial by construction or run against a service
      // that is deliberately stopped.
      //
      // The loop cannot know which is which, and "I could not tell, so I tried
      // to fix it" is how a self-test becomes a defect.
      if (/^probe:\s*true\s*$/m.test(text)) continue;

      const failed = /^status: failed$/m.test(text) || /FAILED `/.test(text);

      // `status: running` is NOT a failure. It is what a request in flight looks
      // like — including, when this loop runs on a schedule, one Grayson is
      // waiting on right now. Treating that as a bug report meant the loop
      // could pick up a live conversation and "fix" it mid-sentence.
      //
      // A run stuck in `running` long after the fact is a different thing: the
      // process died holding it. Age is what separates the two.
      let stuck = false;
      if (!failed && /^status: running$/m.test(text)) {
        const age = Date.now() - (await stat(path)).mtimeMs;
        stuck = age > 30 * 60_000;
      }

      if (failed || stuck) {
        issues.push({
          kind: "run",
          key: `run:${f}`,
          what: `A previous run did not complete cleanly: ${f}`,
          hint: `Read ${path} for the tool trace.`,
        });
      }
    }
  } catch {}

  try {
    const errLog = join(CONFIG.home, "Library/Logs/cleetusd.err.log");
    const text = await readFile(errLog, "utf8");
    const lines = text.trim().split("\n").filter((l) => /error|throw|unhandled/i.test(l)).slice(-5);
    for (const l of lines) issues.push({ kind: "log", key: `log:${l.slice(0, 80)}`, what: `cleetusd logged an error: ${l.slice(0, 200)}`, hint: `From ${errLog}.` });
  } catch {}

  // Five identical stack lines are one bug, not five. They collapse to one key
  // anyway once attempted, but counting them separately made the work list look
  // five times longer than it was and buried the single real item under repeats
  // of a crash that had already been fixed.
  const seen = new Set();
  return issues.filter((i) => {
    if (!i.key) return true;
    if (seen.has(i.key)) return false;
    seen.add(i.key);
    return true;
  });
}

// ── Gates ───────────────────────────────────────────────────────────────────

async function gates(changed) {
  const results = [];
  for (const f of changed.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))) {
    try { await sh(`node --check ${JSON.stringify(f)}`); results.push([`node --check ${f}`, true]); }
    catch (e) { results.push([`node --check ${f}`, false, (e.stderr || e.message).slice(0, 300)]); }
  }
  for (const f of changed.filter((f) => f.startsWith("functions/"))) {
    try { await sh(`node_modules/.bin/esbuild ${JSON.stringify(f)} --bundle --format=esm --platform=neutral --outfile=/dev/null`); results.push([`esbuild ${f}`, true]); }
    catch (e) { results.push([`esbuild ${f}`, false, (e.stderr || e.message).slice(0, 300)]); }
  }
  try { await sh("npm run build"); results.push(["vite build", true]); }
  catch (e) { results.push(["vite build", false, (e.stderr || e.stdout || e.message).slice(0, 300)]); }
  return results;
}

async function changedFiles() {
  const { stdout } = await sh("git diff --name-only HEAD");
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// ── Deploy + verify ─────────────────────────────────────────────────────────

async function waitForDeploy(sha, { timeoutMs = 600_000 } = {}) {
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID || (await import("./config.mjs")).secrets.CLOUDFLARE_ACCOUNT_ID;
  const tok = (await import("./config.mjs")).secrets.CLOUDFLARE_API_TOKEN;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/pages/projects/cleetus/deployments?per_page=1`,
        { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(30_000) });
      const d = (await r.json()).result?.[0];
      const hash = d?.deployment_trigger?.metadata?.commit_hash || "";
      const stage = d?.latest_stage;
      if (hash.startsWith(sha.slice(0, 7))) {
        if (stage?.status === "success" && stage?.name === "deploy") return { ok: true };
        if (stage?.status === "failure") return { ok: false, reason: `build failed at ${stage.name}` };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { ok: false, reason: "deploy did not finish in time" };
}

// ── The loop ────────────────────────────────────────────────────────────────

/**
 * Push the revert, rebasing over anyone who got in first.
 *
 * Pushing the fix and pushing the revert are not the same risk. If the FIX push
 * is rejected, nothing shipped and the failure is safe. If the REVERT push is
 * rejected, the bad commit is already live and simply stays there.
 *
 * That is not hypothetical: with another session pushing to this same repo, the
 * window is the whole deploy wait. Reproduced in a scratch repo — our commit
 * lands, another session pushes on top, and the revert push is refused as a
 * non-fast-forward while the bad change stays live on main. `sh` rejects on a
 * non-zero exit, so it threw out of the loop entirely: no history entry, no
 * "reverted" outcome, just an error, with production still broken.
 *
 * Rebasing the revert onto the new tip lands it and keeps the other session's
 * commit. Failure returns false rather than throwing, so the caller can report
 * a revert that did not happen instead of vanishing into a stack trace.
 */
async function pushRevert(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await sh("git push -q origin main");
      return true;
    } catch (e) {
      log(`revert push rejected (attempt ${i}/${attempts})`, String(e.message || e).slice(0, 120));
      if (i === attempts) return false;
      // Someone else moved main. Replay the revert on top of them.
      try { await sh("git pull -q --rebase origin main"); }
      catch (rebaseFailed) {
        log("rebase of the revert failed — leaving main alone", String(rebaseFailed.message || rebaseFailed).slice(0, 120));
        await sh("git rebase --abort").catch(() => {});
        return false;
      }
    }
  }
  return false;
}

/**
 * What the loop says when it has nothing left to work on.
 *
 * Lifted out of improveOnce so it can be tested: everything around it does git
 * and network work, which is how this sentence went unexamined long enough to
 * become misleading in the first place.
 *
 * A `health:` key is read fresh from /api/health and IS failing right now. A
 * `log:` or `run:` key comes from a file that never forgets — the
 * ERR_HTTP_HEADERS_SENT lines were fixed and verified on 13 Aug and will sit in
 * cleetusd.err.log forever, so they are re-found on every pass and can never
 * clear. Describing those as "still failing" would be the same kind of
 * confident wrong sentence this loop keeps being caught writing.
 */
export function idleSummary(found = []) {
  if (!found.length) return "nothing is wrong";
  const live = found.filter((i) => String(i.key || "").startsWith("health:"));
  const stale = found.length - live.length;
  const names = live.map((i) => String(i.key).slice(7)).join(", ");
  return [
    live.length
      ? `${live.length} check${live.length === 1 ? " is" : "s are"} still failing and already attempted: ${names}`
      : "no live check is failing",
    stale ? `${stale} older log/run record${stale === 1 ? "" : "s"} that cannot clear on their own` : "",
  ].filter(Boolean).join("; ");
}

/**
 * What to call a change that shipped.
 *
 * "Shipped" and "fixed" are different words and the loop was using one for
 * both. 5ab77bb genuinely fixed the brief check; 3909977 improved a message
 * while push stayed exactly as down as before — nothing can fix that from here,
 * the phone has to open the app. The history recorded both as "shipped", and
 * that word is what a person reads months later.
 */
export function shipOutcome(checkName, stillFailing) {
  return stillFailing ? `shipped, but ${checkName} is still failing` : "shipped";
}

export async function improveOnce({ dry = false } = {}) {
  // Every guard below stops the loop from WRITING. None of them is a reason to
  // stop it from LOOKING, and --dry is documented as "find the work, change
  // nothing (start here)".
  //
  // It did not do that. The dirty-tree guard returned before the dry branch, so
  // a dry pass was impossible on a dirty tree — which is to say, impossible on
  // any day Grayson was mid-something, which is the day you most want to read
  // one. Dry now collects the blockers and reports them alongside the work it
  // would have picked.
  const state = await loadState();
  if (state.day !== today()) { state.day = today(); state.count = 0; }
  const { stdout: dirty } = await sh("git status --porcelain");

  const blockers = [];
  if (existsSync(STOP_FILE)) blockers.push(`STOP file present at ${STOP_FILE}`);
  if (state.count >= DAILY_CAP) blockers.push(`daily cap reached (${DAILY_CAP})`);
  // A dirty tree means Grayson is mid-something. Shipping on top of that would
  // put his work in a commit he did not write, and a revert would take it away.
  if (dirty.trim()) blockers.push("working tree is dirty — not touching Grayson's uncommitted work");
  if (!dry && blockers.length) return { skipped: blockers[0] };

  // NOT in a dry run. This is a mutation — it moves whatever branch you are on
  // to main and pulls — and "dry" that changes your checkout is a lie. It sat
  // above the dry branch, so `--dry` on a clean tree would have done exactly
  // that while claiming to change nothing.
  if (!dry) {
    await sh("git fetch -q origin && git checkout -q main && git pull -q --ff-only origin main");
  }
  const { stdout: baseSha } = await sh("git rev-parse HEAD");

  const before = await cloudHealth();

  // A red baseline used to stop the loop outright, on the grounds that it
  // "cannot tell my damage from existing damage". regressed() twenty lines up
  // does exactly that and says so: it diffs the SET of failures and counts only
  // new names. The guard and the comparison contradicted each other.
  //
  // The cost of that contradiction was total. Every health candidate this loop
  // generates has the form "X is down", so whenever there is health work to do
  // the baseline is red BY DEFINITION — the loop could only ever run when it had
  // nothing of that kind to fix. Four scheduled runs, four skips, no cycle ever
  // completed.
  //
  // What genuinely cannot be worked through is a baseline it could not MEASURE.
  // If the site is unreachable then "after" will be unreachable too, the set
  // difference is empty, and a change that broke something real would read as
  // clean. So the distinction is measurable-but-red versus not-measurable, not
  // green versus red.
  const unmeasurable = !before.ok && (before.down || []).includes("unreachable");
  if (unmeasurable && !dry) {
    return { skipped: `cloud health is unreachable (${before.error || "no detail"}) — cannot measure damage, so not risking any` };
  }
  if (unmeasurable) blockers.push("cloud health is unreachable — nothing could be verified");
  else if (!before.ok) blockers.push(`baseline is red (${(before.down || []).join(", ")}) — working anyway, only NEW failures count as damage`);

  const found = await findWork(before);

  // Skip what it has already had a go at.
  //
  // Without this the loop cannot converge. A run file that recorded a failure
  // keeps that record forever — fixing the code does not rewrite history — so
  // the top-ranked issue stays top-ranked after it is fixed, and the loop would
  // spend all three of its daily passes, every day, on the same dead bug. It
  // was pointing at exactly that today: a run marked failed by a heuristic that
  // has since been corrected.
  //
  // Keyed by the issue, not the fix, so "I tried this" survives whether the
  // attempt shipped, reverted, or found nothing to change.
  // Retired unless the check has recovered since the attempt. See
  // recoveredSince(): a failure that went green and came back is a new failure;
  // one that never recovered is the same one, still unfixable by this loop.
  const lastAttempt = new Map();
  for (const h of state.history || []) {
    if (h.key) lastAttempt.set(h.key, h.at || null);
  }
  const issues = [];
  for (const i of found) {
    if (!lastAttempt.has(i.key)) { issues.push(i); continue; }
    const name = String(i.key || "").startsWith("health:") ? i.key.slice(7) : null;
    const when = lastAttempt.get(i.key);

    // Recovery alone is not enough, because some checks recover on a CYCLE.
    // `brief` is green all day and red every night, so "has it been green since
    // the attempt?" is true every single morning — which would put it back on
    // the work list daily and reinstate exactly the waste this retirement rule
    // exists to prevent.
    //
    // A cooldown separates a cycle from a regression. Something genuinely fixed
    // and genuinely broken again is worth another look after a week; something
    // that merely goes green every morning is not worth one every morning.
    const COOLDOWN_DAYS = Number(process.env.CLEETUSD_RETRY_DAYS || 7);
    const oldEnough = when && (Date.now() - Date.parse(when)) > COOLDOWN_DAYS * 86_400_000;

    if (name && oldEnough && await recoveredSince(name, when)) {
      log(`${i.key}: recovered since the last attempt ${COOLDOWN_DAYS}+ days ago and is failing again — treating as new`);
      issues.push(i);
    }
  }

  if (!issues.length) {
    // "All known issues have been attempted" reads like convergence. It is not.
    //
    // `found` is the list of problems detected on THIS pass, so every item in it
    // is failing right now. Saying only that they have all been attempted
    // describes the loop's bookkeeping and hides the actual state of the
    // machine: these are things that are still wrong and that the loop has
    // stopped trying to fix. Retiring them is correct — some need a person, and
    // push cannot be fixed from here at all — but retiring them QUIETLY is how
    // an idle loop comes to look like a healthy one.
    // Not every item in `found` is a live fault, and the first version of this
    // message got that wrong. A `health:` key is read fresh from /api/health, so
    // it IS failing right now. A `log:` or `run:` key comes from a file that
    // never forgets: the ERR_HTTP_HEADERS_SENT lines in cleetusd.err.log were
    // fixed and verified on 13 Aug and will sit in that log forever, so they are
    // re-found on every pass and can never clear. Calling those "still failing"
    // would be exactly the kind of confident wrong sentence this loop keeps
    // being caught writing.
    const why = idleSummary(found);
    return dry ? { wouldFix: null, candidates: 0, seen: found.length, blockers, note: why } : { skipped: why, stillFailing: found.length };
  }

  const issue = issues[0];
  log("working on:", issue.what);
  if (dry) return { wouldFix: issue, candidates: issues.length, blockers };

  const brief = [
    `Fix exactly one thing in the Cleetus codebase at ${REPO}.`,
    ``,
    `THE PROBLEM: ${issue.what}`,
    `WHERE TO LOOK: ${issue.hint}`,
    ``,
    `Rules:`,
    `- Read the relevant files before changing anything.`,
    `- Change the smallest amount that fixes it. No refactors, no drive-by tidying.`,
    `- Do NOT edit any of: ${OFF_LIMITS.map(String).join(", ")}.`,
    `- Do NOT run git commit, git push, or npm run build. That is handled for you.`,
    `- If you cannot find a real cause, change NOTHING and say so plainly. A loop`,
    `  that invents work is worse than one that does nothing.`,
    // The cheapest way to make a failing check pass is to stop it checking. That
    // route has to be closed explicitly, because it always works, it always
    // looks like a fix, and the revert cannot catch it: health goes GREEN, so
    // nothing new is failing and the change stands forever.
    //
    // This is not hypothetical. `brief` is red from midnight until the morning
    // brief is written — about seven hours a night, every night, by design. The
    // loop now sees that as work, and "make the assertion weaker" would score as
    // a success on every measure it has.
    `- NEVER make a check pass by weakening what it asserts. Do not loosen a`,
    `  condition, widen a tolerance, remove an assertion, or make a failure`,
    `  report as ok. Fix the thing being measured, not the measurement.`,
    `- Some checks are RED FOR A GOOD REASON at some times of day — a brief that`,
    `  is not written until morning is not a bug at 01:00. If the check is correct`,
    `  and the underlying thing is genuinely fine, change NOTHING and say which`,
    `  condition made it red. That is a complete and useful answer.`,
    // Written while four checks were red from one database outage and an expired
    // OAuth token. Neither has a fix in this repository, and the loop has three
    // cycles a day: spent on those, it does nothing else all day. Worse, a model
    // told to fix something with no code-level cause will find SOMETHING to
    // change, and that change is unrelated by construction.
    `- Some failures have NO CAUSE IN THIS CODE. An expired OAuth token, a database`,
    `  refusing reads, a third-party API that is down, a device that was never`,
    `  registered. The tell is that the code path is correct and the data or the`,
    `  credential underneath it is missing — "db_error", "needsAuth",`,
    `  "Could not get access token", "no devices".`,
    `- When that is the case, change NOTHING. Say what the underlying cause is and`,
    `  what a human would have to do about it. Do not add a retry, a fallback, or a`,
    `  friendlier error to make a broken dependency look handled. Diagnosing`,
    `  something you cannot fix IS the useful answer.`,
    ``,
    `When done, state in one line what you changed and why.`,
  ].join("\n");

  // A repair needs more room than a conversation. The first live cycle spent all
  // twenty steps reading — the right files, in the right order — and hit the
  // ceiling before it edited anything. Reading is most of the work here, so the
  // budget has to cover reading AND the edit AND checking the edit; twenty
  // covers only the first.
  const result = await ask({
    history: [{ role: "user", content: brief }],
    agent: "builder",
    maxSteps: Number(process.env.CLEETUSD_IMPROVE_STEPS || 40),
    // The loop repairing itself is not a request Grayson made.
    //
    // askModel() in jobs.mjs was marked, but this call goes straight to ask()
    // and was missed — so the builder's own run landed in his open loops as
    // "UNFINISHED · Fix exactly one thing in the Cleetus codebase", and in the
    // deck's recent work, and in the digests the analysis reads. Its 40-step
    // budget makes it the single most likely run to look unfinished, which is
    // exactly the one that should not be presented to him as his.
    probe: true,
  });

  const changed = await changedFiles();
  if (!changed.length) {
    // "No change made" covers two completely different things: deciding nothing
    // needed changing, and running out of room mid-repair. The first cycle was
    // the second kind and was filed as the first, which is how a loop that
    // achieves nothing looks like a loop that had nothing to do.
    const ranOut = endsOnAPromise(result.answer || "");
    const outcome = ranOut ? "gave up mid-repair (answer stops on a promise)" : "no change made";
    state.count++;
    state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome, said: (result.answer || "").slice(0, 200) });
    await saveState(state);
    return { outcome, issue: issue.what, said: result.answer };
  }

  const forbidden = changed.filter((f) => OFF_LIMITS.some((re) => re.test(f)));
  if (forbidden.length) {
    await sh("git checkout -- . && git clean -fd");
    // Recorded like any other attempt. This used to return without writing
    // history, so the same issue came back on the next pass and reached for the
    // same forbidden file, indefinitely.
    state.count++;
    state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome: "reverted before gates", detail: forbidden.join(", ") });
    await saveState(state);
    return { outcome: "reverted before gates", reason: `touched off-limits files: ${forbidden.join(", ")}` };
  }

  const gateResults = await gates(changed);
  const failed = gateResults.filter((g) => !g[1]);
  if (failed.length) {
    await sh("git checkout -- . && git clean -fd");
    state.count++; state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome: "gates failed", detail: failed.map((f) => f[0]).join(", ") });
    await saveState(state);
    return { outcome: "gates failed, nothing shipped", failed: failed.map((f) => ({ gate: f[0], detail: f[2] })), changed };
  }

  // The baseline is stated, not assumed. This message used to say "Baseline
  // health was green before this" unconditionally, which stopped being true the
  // moment the loop was allowed to work through a red baseline — and this line
  // is exactly what someone reads months later when working out whether a
  // commit is implicated in an outage. A commit message that misdescribes the
  // conditions it shipped under is worse than one that says nothing.
  const baseline = before.ok
    ? "green"
    : `red (${(before.down || []).join(", ")}) — those were already failing and are not this commit's doing`;
  // The file list comes from git, the prose comes from the model, and the
  // message says which is which.
  //
  // The first autonomous commit described adding a Content-Type header to
  // _lib/apns.js. It changed functions/api/health.js and nothing else. The
  // builder had run out of steps and its closing summary described what it
  // INTENDED to do next, which then became the permanent record of what it did.
  // Someone reading `git log` in six months would believe apns.js was fixed.
  //
  // So the diff is stated first, as fact, and the model's account is labelled as
  // an account. If the answer was truncated that is said out loud too, because a
  // summary written after running out of room is exactly the one likely to
  // describe intentions as actions.
  const truncated = /\[(Answered from partial information|Stopped here after)/.test(result.answer || "");
  const msg =
    `Cleetus: ${issue.what.slice(0, 60)}\n\n` +
    `Files changed (from git, authoritative):\n${changed.map((f) => `  ${f}`).join("\n")}\n\n` +
    `What the builder said it did — its own account, which may not match the diff above:\n` +
    `${(result.answer || "").slice(0, 800)}\n\n` +
    (truncated
      ? `NOTE: the builder ran out of tool calls before finishing. Treat the account above as\n` +
        `its intentions rather than a description of this commit.\n\n`
      : "") +
    `Fixed autonomously by the improve loop. Baseline health was ${baseline}.\n` +
    `Only failures NEW since that baseline trigger the automatic revert.`;
  await sh(`git add -A && git commit -q -F - <<'EOF'\n${msg}\nEOF`);
  const { stdout: newSha } = await sh("git rev-parse HEAD");
  await sh("git push -q origin main");
  log("pushed", newSha.trim().slice(0, 7));

  const deployed = await waitForDeploy(newSha.trim());
  let after = null, why = null;

  if (!deployed.ok) {
    why = deployed.reason;
  } else {
    // Give ISR and the edge a moment before judging.
    await new Promise((r) => setTimeout(r, 20_000));
    after = await cloudHealth();
    why = regressed(before, after);
  }

  if (why) {
    log("REVERTING:", why);
    await sh(`git revert --no-edit ${newSha.trim()}`);
    const undone = await pushRevert();
    const { stdout: revSha } = await sh("git rev-parse HEAD");
    const revDeployed = undone ? await waitForDeploy(revSha.trim()) : { ok: false, reason: "revert was never pushed" };
    state.count++;
    state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome: undone ? "reverted" : "REVERT FAILED — bad commit still live", why, sha: newSha.trim().slice(0, 7) });
    await saveState(state);
    // Never report a revert that did not happen. This value is what the
    // heartbeat and the doctor read, and "reverted" with the change still live
    // is the single most dangerous thing this loop could say.
    return {
      outcome: undone ? "reverted" : "REVERT FAILED — bad commit still live on main",
      why,
      sha: newSha.trim().slice(0, 7),
      revert_pushed: undone,
      revert_deployed: revDeployed.ok,
      baseSha: baseSha.trim().slice(0, 7),
    };
  }

  // Write down how it was fixed — but ONLY if it was fixed, and only from what
  // is known to have happened.
  //
  // The first autonomous cycle wrote a skill whose second step was: add a
  // Content-Type header to the crumb function in _lib/apns.js. That change was
  // never made, that file was never touched, and it is not why push is down —
  // nothing has been pushed since 9 August. The fiction went from a truncated
  // answer, into the commit message, into a skill, and skills are retrieved into
  // future prompts. Left alone it would have misdirected the next attempt at
  // this exact problem, with the authority of something the system had "learned".
  //
  // Three conditions now, because each one was violated by that first skill:
  //   - the answer must not be truncated; a summary written after running out of
  //     room describes intentions, and a procedure made of intentions is worse
  //     than no procedure
  //   - the issue must actually have cleared; "shipped and nothing else broke" is
  //     not the same as "fixed", and push was still down
  //   - the steps quote the DIFF, not the prose
  const checkName = String(issue.key || "").startsWith("health:") ? issue.key.slice(7) : null;
  const stillFailing = checkName && after && (after.down || []).includes(checkName);
  const truncatedAnswer = /\[(Answered from partial information|Stopped here after)/.test(result.answer || "");

  if (truncatedAnswer || stillFailing) {
    log("no skill written:", truncatedAnswer ? "the answer was truncated" : `${checkName} is still failing`);
  } else {
    await saveSkill({
      title: `Fix: ${issue.what.slice(0, 60)}`,
      when: `something like "${issue.what.slice(0, 80)}" shows up again`,
      steps: [
        issue.hint,
        `What actually changed: ${changed.join(", ")}. Read that diff first — it is the record of the fix.`,
        "Gates: node --check, esbuild the changed functions, npm run build.",
        "Verify /api/health after the deploy, not before.",
      ],
      agent: "builder",
    }).catch(() => {});
  }

  // "Shipped" is not "fixed", and the log said "shipped" for both.
  //
  // stillFailing is computed a few lines up, and was already trusted enough to
  // withhold a skill — so the loop KNEW the issue had not cleared and wrote down
  // the same word it uses for a real fix. The two autonomous commits are the
  // proof: 5ab77bb genuinely fixed the brief check, and 3909977 improved a
  // message while push stayed exactly as down as it had been, because nothing
  // can fix that from here — the phone has to open the app. Both say "shipped".
  //
  // That word is what a person reads months later, and it is what makes this
  // loop's own idleness misleading: "all known issues have been attempted"
  // sounds like convergence when some of those attempts changed nothing.
  const outcome = shipOutcome(checkName, stillFailing);
  state.count++;
  state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome, fixed: !stillFailing, sha: newSha.trim().slice(0, 7) });
  await saveState(state);
  if (stillFailing) log(`${checkName} is still down after this shipped — the change did not fix it`);
  return { outcome, fixed: !stillFailing, issue: issue.what, sha: newSha.trim().slice(0, 7), changed, said: result.answer };
}
