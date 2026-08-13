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
//   - Run if the baseline is already red. It could not tell its own damage
//     from the damage that was there when it started.
//   - Touch its own files. A loop that edits its revert path can put itself
//     somewhere it cannot get back from.
//   - Exceed a daily cap, or run at all while a STOP file exists.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "./config.mjs";
import { ask } from "./agent.mjs";
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

async function findWork(health) {
  const issues = [];

  for (const name of health.down || []) {
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
  if (!before.ok && !dry) return { skipped: `baseline is already red (${(before.down || []).join(", ")}) — cannot tell my damage from existing damage` };
  if (!before.ok) blockers.push(`baseline is already red (${(before.down || []).join(", ")})`);

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
  const attempted = new Set((state.history || []).map((h) => h.key).filter(Boolean));
  const issues = found.filter((i) => !attempted.has(i.key));

  if (!issues.length) {
    const why = found.length ? `nothing new — all ${found.length} known issues have been attempted` : "nothing is wrong";
    return dry ? { wouldFix: null, candidates: 0, seen: found.length, blockers, note: why } : { skipped: why };
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
    ``,
    `When done, state in one line what you changed and why.`,
  ].join("\n");

  const result = await ask({ history: [{ role: "user", content: brief }], agent: "builder" });

  const changed = await changedFiles();
  if (!changed.length) {
    state.count++; state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome: "no change made" });
    await saveState(state);
    return { outcome: "no change made", issue: issue.what, said: result.answer };
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

  const msg = `Cleetus: ${issue.what.slice(0, 60)}\n\n${result.answer.slice(0, 800)}\n\nFixed autonomously by the improve loop. Baseline health was green before this;\nif it goes red this commit is reverted automatically.`;
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
    await sh("git push -q origin main");
    const { stdout: revSha } = await sh("git rev-parse HEAD");
    const revDeployed = await waitForDeploy(revSha.trim());
    state.count++;
    state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome: "reverted", why, sha: newSha.trim().slice(0, 7) });
    await saveState(state);
    return { outcome: "reverted", why, sha: newSha.trim().slice(0, 7), revert_deployed: revDeployed.ok, baseSha: baseSha.trim().slice(0, 7) };
  }

  // It worked. Write down how, so the next one is cheaper.
  await saveSkill({
    title: `Fix: ${issue.what.slice(0, 60)}`,
    when: `something like "${issue.what.slice(0, 80)}" shows up again`,
    steps: [issue.hint, result.answer.slice(0, 400), "Gates: node --check, esbuild the changed functions, npm run build.", "Verify /api/health after the deploy, not before."],
    agent: "builder",
  }).catch(() => {});

  state.count++;
  state.history.push({ at: new Date().toISOString(), key: issue.key, issue: issue.what, outcome: "shipped", sha: newSha.trim().slice(0, 7) });
  await saveState(state);
  return { outcome: "shipped", issue: issue.what, sha: newSha.trim().slice(0, 7), changed, said: result.answer };
}
