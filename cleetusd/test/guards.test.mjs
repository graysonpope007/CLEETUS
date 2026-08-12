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

// 1. STOP file
await writeFile(STOP_FILE, "test\n", "utf8");
let r = await improveOnce({ dry: true });
t("STOP file halts the loop", /STOP file/.test(r.skipped || ""), JSON.stringify(r));
await unlink(STOP_FILE);

// 2. dirty tree
const junk = join(REPO, "__improve_guard_test.tmp");
await writeFile(junk, "scratch\n", "utf8");
r = await improveOnce({ dry: true });
t("dirty tree halts the loop", /dirty/.test(r.skipped || ""), JSON.stringify(r));
await unlink(junk);
const { stdout: clean } = await sh("git status --porcelain", REPO);
t("test left the repo clean", clean.trim() === "", clean);

// 3. daily cap
const STATE = join(CONFIG.memoryRoot, "improve-state.json");
const saved = existsSync(STATE) ? await (await import("node:fs/promises")).readFile(STATE, "utf8") : null;
await writeFile(STATE, JSON.stringify({ day: new Date().toISOString().slice(0,10), count: 99, history: [] }), "utf8");
r = await improveOnce({ dry: true });
t("daily cap halts the loop", /cap/.test(r.skipped || ""), JSON.stringify(r));
if (saved) await writeFile(STATE, saved, "utf8"); else await rm(STATE, { force: true });

// 4. findWork surfaces a genuinely failed run
const runsDir = join(CONFIG.memoryRoot, CONFIG.runsDir);
await mkdir(runsDir, { recursive: true });
const fake = join(runsDir, "9999-01-01-0000-guard-test.md");
await writeFile(fake, "---\nagent: builder\nstatus: failed\n---\n\n# guard test\n\n- FAILED `read_file` {}\n", "utf8");
r = await improveOnce({ dry: true });
t("a failed run becomes work", !!r.wouldFix, JSON.stringify(r).slice(0,200));
t("it names the failed run", /guard-test/.test(JSON.stringify(r.wouldFix || {})), JSON.stringify(r.wouldFix));
await rm(fake, { force: true });

// 5. back to quiet
r = await improveOnce({ dry: true });
t("returns to 'nothing is wrong' once cleaned up", /nothing is wrong/.test(r.skipped || ""), JSON.stringify(r));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
