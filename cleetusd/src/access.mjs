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
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";

/**
 * The binary macOS will actually attach the grant to.
 *
 * This is the whole reason "I already granted node Full Disk Access" and "node
 * is denied Full Disk Access" have both been true at the same time. TCC keys on
 * the real executable, and:
 *
 *   /opt/homebrew/bin/node  is a symlink into
 *   /opt/homebrew/Cellar/node/26.3.0/bin/node
 *
 * The Finder + dialog resolves the symlink, so what lands in the list is the
 * VERSIONED path. Then `brew upgrade node` writes 26.4.0 into a new Cellar
 * directory, repoints the symlink, and the grant is now attached to a binary
 * that no longer runs anything. Nothing announces it. The daemon starts fine,
 * answers everything, and simply cannot see Mail any more.
 *
 * So the fix string names the resolved path and says the upgrade will undo it,
 * because "add node" is the advice that has already been followed.
 */
function grantTarget() {
  // process.execPath is ALREADY resolved — Node reports the real binary, not
  // whatever symlink launched it. So comparing it to itself always said "not
  // versioned" and the caveat never fired, on the one machine where it is the
  // whole problem. The comparison has to run the other way: take the path a
  // person would type, resolve THAT, and see whether it lands somewhere else.
  const real = process.execPath || "/opt/homebrew/bin/node";
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const link of candidates) {
    try {
      if (realpathSync(link) === real && link !== real) return { link, real, versioned: true };
    } catch { /* not installed there */ }
  }
  // No symlink points at it, or it is versioned with nothing pointing at it.
  // A version number in the path is the fact the caveat is about, and every
  // node manager puts one there: Homebrew's Cellar/node/26.3.0, fnm's
  // node-versions/v22.22.2, nvm's versions/node/v20.11.0, asdf's
  // installs/nodejs/21.6.0. All four move the binary on an upgrade and all four
  // leave the grant behind.
  return { link: real, real, versioned: /\/v?\d+\.\d+\.\d+\//.test(real) };
}

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
  // Messages and Safari are TCC-protected exactly like Mail, and both are
  // denied right now — but only Mail was probed, so this report answered "what
  // can you see" while staying silent about two of the places it cannot.
  //
  // That silence is the dangerous shape. The whole point of check_access is
  // that the model consults it before telling Grayson something is not there;
  // asked "can you read my texts", it would have found no mention of Messages
  // and had no reason to doubt itself.
  ["messages", join(CONFIG.home, "Library/Messages")],
  ["safari", join(CONFIG.home, "Library/Safari")],
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

  const bin = grantTarget();
  // Mail, Messages and Safari are not "more protected than Documents" by
  // degree — they are behind a DIFFERENT switch. Desktop, Documents and
  // Downloads each have their own per-folder consent, which this process
  // evidently has (they read fine). The three library stores are reachable
  // only through Full Disk Access, which is why exactly those three are red
  // while everything around them is green, and why granting the folders again
  // does nothing.
  const FDA_ONLY = new Set(["mail", "messages", "safari"]);
  const needsFda = denied.filter((d) => FDA_ONLY.has(d));

  const fix = denied.length
    ? {
        summary: needsFda.length === denied.length
          ? `${needsFda.join(", ")} need Full Disk Access, which is a different switch from the ` +
            `per-folder permissions the rest of this list uses. Nothing else is wrong.`
          : `${denied.join(", ")} are refused by macOS.`,
        // Opens the pane directly. The path is the awkward part of this
        // instruction and it is the part people get wrong.
        pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        binary: bin.real,
        symlink: bin.versioned ? bin.link : null,
        steps: [
          "Open System Settings > Privacy & Security > Full Disk Access.",
          `Press +, then Cmd+Shift+G, and paste: ${bin.real}`,
          "Tick it, and authenticate.",
          "Then: launchctl kickstart -k gui/$(id -u)/com.cleetus.cleetusd",
        ],
        // The trap, said out loud, because this is the one that makes a
        // working grant silently stop working months later.
        caveat: bin.versioned
          ? `That path has a version number in it${bin.link !== bin.real ? ` (${bin.link} is only a symlink to it)` : ""}, ` +
            `and the grant attaches to the binary rather than to the name. Upgrading node moves the ` +
            `real binary into a new directory and leaves the grant behind pointing at the old one — ` +
            `everything keeps working except these, with no error anywhere. If this list goes red ` +
            `again after an update, that is what happened: re-add the new path.`
          : null,
      }
    : blocked.length
      ? { summary: "An iCloud path is not responding. It usually clears on its own; cleetusd time-boxes it either way, so this degrades rather than hanging.", steps: [], pane: null, binary: null, symlink: null, caveat: null }
      : null;

  return {
    full_access: denied.length === 0 && blocked.length === 0,
    denied,
    blocked,
    needs_full_disk_access: needsFda,
    running_as: bin.real,
    fix,
    // The old shape was a single string and the deck, the reach page and the
    // model all read it. Kept, so nothing that reads `fix` as text breaks while
    // the structured version above is what the UI uses.
    fix_text: fix ? [fix.summary, ...(fix.steps || []), fix.caveat].filter(Boolean).join(" ") : null,
    targets: results,
  };
}
