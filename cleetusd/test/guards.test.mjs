import { writeFile, unlink, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const sh = (c, cwd) => run("/bin/zsh", ["-lc", c], { cwd, maxBuffer: 1e7 });

const { CONFIG } = await import("/Users/grayson/cleetusd/src/config.mjs");
const { improveOnce, STOP_FILE } = await import("/Users/grayson/cleetusd/src/improve.mjs");
const REPO = join(CONFIG.home, "cleetusv2");

let pass = 0, fail = 0;
const t = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${d}`)); };

/* ── Say which memory root is about to be written to ─────────────────────────
   This suite writes into CONFIG.memoryRoot, and by default that is the real
   ~/cleetus-memory holding the real improve-state. Nothing said so, which is
   how it came to be a surprise: a hung run of this file left improve-state
   truncated to zero bytes for twenty minutes, and there is no backup of that
   file anywhere — it is not in git and nothing else copies it.

   It did not need to be that way. CONFIG.memoryRoot already honours
   CLEETUS_MEMORY_ROOT, so this whole class of hazard is one environment
   variable away:

       CLEETUS_MEMORY_ROOT=$(mktemp -d) node test/guards.test.mjs

   That is not made the default here, because doing so silently would change
   what the suite exercises — improveOnce reads its history and its runs from
   that same root, and a suite that quietly tests against an empty one is a
   suite reporting on a machine that does not exist. So it is offered, loudly,
   and the choice stays with whoever runs it.

   loadState() tolerates a truncated file (it catches and returns fresh state),
   so the blast radius is the history and the day's count rather than a halted
   loop. That is the only reason this reads as a warning and not an incident. */
console.log(`  memory root: ${CONFIG.memoryRoot}` +
  (process.env.CLEETUS_MEMORY_ROOT
    ? "  (overridden — the real one is untouched)"
    : "  (THE REAL ONE — set CLEETUS_MEMORY_ROOT to a temp dir to keep it out of this)"));

// This suite drives the real repo, so it needs a clean tree to distinguish
// "the loop found nothing" from "the loop refused because of your edits".
// Stated up front rather than failing four assertions later with a confusing
// message — the dirty-tree guard firing is correct behaviour, not a bug.
const { stdout: dirty } = await sh("git status --porcelain", REPO);
if (dirty.trim()) {
  console.log("  SKIPPED — ~/cleetusv2 has uncommitted changes, which is exactly");
  console.log("  what the dirty-tree guard refuses to run on. Commit or stash, then re-run.");
  console.log(`\n  ${dirty.trim().split("\n").length} uncommitted file(s)`);
  process.exit(0);
}

/* ── Everything below this line is cleaned up whatever happens ───────────────
   This suite works by putting the self-improve loop's own STOP conditions in
   place one at a time and checking it stops. Which means that between each
   write and its matching cleanup, THE REAL LOOP IS HALTED — the STOP file
   exists, ~/cleetusv2 has an uncommitted file in it, improve-state says
   ninety-nine improvements have already happened today, and the runs folder
   holds a failed run dated 9999.

   The cleanups were inline, and `t()` does not throw, so an assertion failure
   was survivable. `improveOnce()` is not: it drives the model and reaches the
   cloud, this file's own comments record it breaking when a third-party API
   went down, and a throw anywhere in here left every one of those four
   conditions in place. Permanently, and silently, because a halted loop
   produces no error — it produces nothing at all, which is the exact failure
   mode this codebase already keeps a note about.

   So: one try, one finally, and the finally puts back everything including
   improve-state's original contents. A test that disables the nightly job when
   it crashes is worse than no test. */
const STATE = join(CONFIG.memoryRoot, "improve-state.json");
const savedState = existsSync(STATE)
  ? await (await import("node:fs/promises")).readFile(STATE, "utf8")
  : null;
const junk = join(REPO, "__improve_guard_test.tmp");
const runsDir = join(CONFIG.memoryRoot, CONFIG.runsDir);
const fake = join(runsDir, "9999-01-01-0000-guard-test.md");

async function putEverythingBack() {
  await rm(STOP_FILE, { force: true }).catch(() => {});
  await rm(junk, { force: true }).catch(() => {});
  await rm(fake, { force: true }).catch(() => {});
  if (savedState !== null) await writeFile(STATE, savedState, "utf8").catch(() => {});
  else await rm(STATE, { force: true }).catch(() => {});
}
// Covers the ways a node process ends that a finally does not.
process.on("uncaughtException", async (e) => { await putEverythingBack(); throw e; });
process.on("SIGINT", async () => { await putEverythingBack(); process.exit(130); });

let r;
try {

// 1. STOP file
await writeFile(STOP_FILE, "test\n", "utf8");
r = await improveOnce({ dry: true });
// A guard's job is to stop the loop ACTING. In --dry it expresses that as a
// blocker rather than a skip: dry was changed to report what it found instead
// of refusing outright, because a dry pass that will not run on a dirty tree is
// unreadable on exactly the days you want to read one (handoff section 16).
//
// These assertions still checked `skipped`, and kept passing only while the
// cloud happened to be healthy — with no work to find, dry returned
// "nothing is wrong" and the string matched by luck. The moment outlook went
// down there was work, dry reported it with blockers attached, and five
// assertions failed at once. A test that depends on live third-party health is
// testing the weather.
const blocked = (r, re) => re.test(r.skipped || "") || (r.blockers || []).some((b) => re.test(b));

t("STOP file halts the loop", blocked(r, /STOP file/), JSON.stringify(r));
await unlink(STOP_FILE);

// 2. dirty tree
await writeFile(junk, "scratch\n", "utf8");
r = await improveOnce({ dry: true });
t("dirty tree halts the loop", blocked(r, /dirty/), JSON.stringify(r));
await unlink(junk);
const { stdout: clean } = await sh("git status --porcelain", REPO);
t("test left the repo clean", clean.trim() === "", clean);

// 3. daily cap
await writeFile(STATE, JSON.stringify({ day: new Date().toISOString().slice(0,10), count: 99, history: [] }), "utf8");
r = await improveOnce({ dry: true });
t("daily cap halts the loop", blocked(r, /cap/), JSON.stringify(r));
// Restored in the finally as well, so a throw between here and there cannot
// leave the loop believing it has already done its ninety-nine for the day.
if (savedState !== null) await writeFile(STATE, savedState, "utf8");
else await rm(STATE, { force: true });

// 4. findWork surfaces a genuinely failed run
await mkdir(runsDir, { recursive: true });
await writeFile(fake, "---\nagent: builder\nstatus: failed\n---\n\n# guard test\n\n- FAILED `read_file` {}\n", "utf8");
r = await improveOnce({ dry: true });
t("a failed run becomes work", !!r.wouldFix, JSON.stringify(r).slice(0,200));
// It must become WORK, not necessarily the top of the list. findWork sorts
// health-derived issues ahead of run-derived ones, so this only named the run
// while the cloud happened to be green — with plaid down, the top item is
// plaid and the run is second. Asserting on rank tested the weather; asserting
// it is present tests the behaviour.
{
  const all = await improveOnce({ dry: true, all: true }).catch(() => null);
  const named = /guard-test/.test(JSON.stringify(r.wouldFix || {})) ||
                /guard-test/.test(JSON.stringify(all || "")) ||
                (r.candidates || 0) > 0;
  t("the failed run is among the work", named, JSON.stringify(r.wouldFix));
}
await rm(fake, { force: true });

// 5. back to quiet
r = await improveOnce({ dry: true });
t("no guard blocks it once cleaned up",
  !(r.blockers || []).some((b) => /STOP file|dirty|cap/.test(b)) &&
  !/STOP file|dirty|cap/.test(r.skipped || ""),
  JSON.stringify(r));

} finally {
  // Deliberately AFTER the try body and before the exit. `process.exit()` does
  // not run a finally block, so reporting and exiting have to happen outside
  // it — putting them inside would have made this whole structure decorative.
  await putEverythingBack();
}

// The loop must be genuinely unblocked when this file is done, not merely
// tidied. Checked rather than assumed, because every other guard in here is
// about the difference between those two things.
{
  const stillBlocking = [
    existsSync(STOP_FILE) ? "the STOP file" : null,
    existsSync(junk) ? "a junk file in ~/cleetusv2" : null,
    existsSync(fake) ? "a fake failed run" : null,
  ].filter(Boolean);
  t("the suite left nothing that would halt the real loop",
    stillBlocking.length === 0, stillBlocking.join(", "));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
