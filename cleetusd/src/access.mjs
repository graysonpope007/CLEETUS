// src/access.mjs — can Cleetus actually reach the whole machine?
//
// There is no allowlist in this codebase; every path is permitted by design.
// But "permitted by the code" and "reachable by the process" are different
// things on macOS, and the gap is invisible until something quietly returns
// nothing:
//
//   TCC        ~/Desktop, ~/Documents, ~/Downloads and the Photos and Mail
//              stores are protected. A process without Full Disk Access gets
//              EPERM, which reads in a tool result like "the folder is empty".
//   CloudDocs  iCloud paths do not fail at all. They BLOCK, uncancellably.
//              Observed on the first launchd start: __opendir2 -> open$NOCANCEL.
//
// So this probes each location and reports one of three states. The point is
// that a denial is never silent: cleetusd should be able to say "I cannot see
// your Desktop, grant node Full Disk Access" instead of "there is nothing on
// your Desktop".

import { execFile } from "node:child_process";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";

const TARGETS = [
  ["home", CONFIG.home],
  ["desktop", join(CONFIG.home, "Desktop")],
  ["documents", join(CONFIG.home, "Documents")],
  ["downloads", join(CONFIG.home, "Downloads")],
  ["obsidian vault", CONFIG.vault],
  ["icloud drive", join(CONFIG.home, "Library/Mobile Documents")],
  ["memory root", CONFIG.memoryRoot],
  ["code (cleetusv2)", join(CONFIG.home, "cleetusv2")],
  ["mail", join(CONFIG.home, "Library/Mail")],
  ["photos", join(CONFIG.home, "Pictures")],
  ["volumes", "/Volumes"],
];

/**
 * Probes run in a KILLABLE CHILD PROCESS, not with fs.readdir.
 *
 * This is not fussiness. A timed-out readdir is not cancelled — Promise.race
 * abandons the promise but the open() is still sat in the kernel holding one
 * of libuv's four threadpool slots, forever. The first version of this file
 * probed sequentially with readdir and produced:
 *
 *   ok home · BLOCKED desktop · ok documents · BLOCKED downloads ·
 *   BLOCKED vault · BLOCKED icloud · BLOCKED memory root · BLOCKED cleetusv2 ...
 *
 * ~/cleetus-memory and ~/cleetusv2 are plain local directories that read
 * instantly. They "blocked" because four genuinely wedged probes had eaten
 * every slot and starved everything behind them. The report was mostly false,
 * and worse, the same starvation applies to the daemon as a whole: four
 * wedged reads anywhere and Cleetus cannot touch the disk at all.
 *
 * A child process can be killed. Killing it frees the slot and the descriptor,
 * and the parent's pool is never touched.
 */
function probe(path, ms = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile("/bin/ls", ["-1", path], { timeout: ms, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const took = Date.now() - started;
        if (!err) {
          return resolve({ state: "ok", items: stdout.split("\n").filter(Boolean).length, ms: took });
        }
        if (err.killed) return resolve({ state: "blocked", detail: "did not answer within " + ms + "ms", ms: took });
        const msg = String(stderr || err.message);
        if (/Operation not permitted/i.test(msg)) {
          return resolve({ state: "denied", detail: "macOS TCC — needs Full Disk Access", ms: took });
        }
        if (/No such file/i.test(msg)) return resolve({ state: "absent", detail: "does not exist", ms: took });
        if (/Permission denied/i.test(msg)) return resolve({ state: "denied", detail: "permission denied", ms: took });
        return resolve({ state: "error", detail: msg.trim().slice(0, 80), ms: took });
      });
    child.on("error", () => resolve({ state: "error", detail: "could not spawn ls", ms: Date.now() - started }));
  });
}

export async function accessReport() {
  // Parallel is safe now: each probe is its own process, so a wedged one
  // cannot starve the others. It also means the whole report is bounded by the
  // single timeout rather than the sum of eleven of them.
  const results = {};
  const settled = await Promise.all(TARGETS.map(async ([name, path]) => [name, { path, ...(await probe(path)) }]));
  for (const [name, r] of settled) results[name] = r;

  const denied = Object.entries(results).filter(([, r]) => r.state === "denied").map(([k]) => k);
  const blocked = Object.entries(results).filter(([, r]) => r.state === "blocked").map(([k]) => k);

  return {
    full_access: denied.length === 0 && blocked.length === 0,
    denied,
    blocked,
    fix: denied.length
      ? "Give node Full Disk Access: System Settings > Privacy & Security > Full Disk Access > + > /opt/homebrew/bin/node (press Cmd+Shift+G to type the path), then `launchctl kickstart -k gui/$(id -u)/com.cleetus.cleetusd`."
      : blocked.length
        ? "An iCloud path is not responding. It usually clears on its own; cleetusd time-boxes it either way, so this degrades rather than hanging."
        : null,
    targets: results,
  };
}
