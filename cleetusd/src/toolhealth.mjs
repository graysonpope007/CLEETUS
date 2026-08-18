// src/toolhealth.mjs — which of his tools are actually working.
//
// On 14 Aug 2026 ripgrep left this machine and `search_files` began answering
// "search failed" to every question asked of it. That lasted hours. The only
// record was a line inside a run file, and run files are read by nobody unless
// they already suspect something is wrong.
//
// Section 115's check counted tools that had NEVER been called. This is the
// failure that count cannot see: a tool that is called constantly, and fails
// constantly. The run files already hold the evidence — every call and its
// result is written down as it happens — so the answer is countable rather
// than guessable. It just needed something to do the counting.
//
// The whole difficulty is one distinction:
//
//   "No matches for X"      — the tool RAN. There was nothing there. Healthy.
//   "search failed: ..."    — the tool could not run at all. Broken.
//
// Getting that backwards in either direction ruins the check. Treat an empty
// result as breakage and it screams on every honest miss until it is ignored;
// treat breakage as an empty result and it stays silent through exactly the
// outage it exists to catch. So neither list is inferred from a keyword — both
// are written out, and the healthy list is checked FIRST.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The tool ran and honestly had nothing to report.
 *
 * Checked before the broken list, because several of these contain words like
 * "no" and "not" that a keyword rule would call failure.
 */
const RAN_FINE = [
  "no matches for",
  "nothing named like",
  "nothing in the vault about",
  "no runs in the last",
  "nobody is in front of",
  "no conversation with id",
  "(empty file)",
  "is empty",
];

/**
 * The tool could not do its job.
 *
 * "No such file" and "Not found in" are deliberately ABSENT: those mean the
 * model passed a path that is not there, which is a bad argument rather than a
 * broken tool, and a check that fires on them would be reporting the model's
 * typos as an outage.
 */
const BROKEN = [
  "search failed:",
  "find failed:",
  "no such tool:",
  "could not ",
  "failed:",
  "is not running",
  "not answering",
  "fetch failed",
  "enoent",
  "command failed",
  "traceback (most recent call last)",
];

/**
 * Did this tool result mean the tool itself could not run?
 *
 * The length rule is not a nicety. `read_file` returns whatever is in the file,
 * and this codebase is full of source that says "failed:" and "could not" in
 * its own error handling — so scanning result BODIES marked two perfectly good
 * reads as outages. When one of our tools cannot run it says so in one short
 * line and returns nothing else; a long result is a tool that worked, whatever
 * words happen to appear inside it.
 */
const MAX_FAILURE_LEN = 500;

/**
 * Tools whose result is arbitrary CONTENT rather than a report.
 *
 * `read_file` hands back whatever is in the file, and this repository is full
 * of health-checking code that says "not answering" and "could not" in its own
 * strings — so a read of doctor.mjs read as an outage of read_file. For these,
 * a failure has to be the WHOLE result and start it: `search failed:` opens the
 * line or the tool worked. `run_shell` is here too, and for a different reason:
 * a command exiting non-zero is the model's command failing, not the tool.
 */
const CONTENT_TOOLS = new Set(["read_file", "vault_search", "recall_chat", "list_dir", "run_shell", "search_files", "find_files"]);

export function looksBroken(result, tool = "") {
  const raw = String(result || "").trim();
  if (!raw || raw.length > MAX_FAILURE_LEN) return false;
  // ...and the marker has to be near the FRONT of that line. A tool announces
  // its own failure first thing; it does not bury it 200 characters into a
  // sentence. One line of dense JavaScript read out of a file was enough to
  // trip a whole-line match, because the code's own error handling says
  // "could not" somewhere in the middle of it.
  const first = raw.split("\n")[0].slice(0, 80).toLowerCase();
  if (RAN_FINE.some((p) => first.includes(p))) return false;
  if (CONTENT_TOOLS.has(tool)) return BROKEN.some((p) => first.startsWith(p));
  return BROKEN.some((p) => first.includes(p));
}

/**
 * Every tool call in a run file, with the result that came back.
 *
 * A call is `- \`tool_name\` {json}` and its result is every line after it up
 * to the next call or the next heading. Results run to several lines — file
 * contents, search hits — so reading only the first line would miss both the
 * failures that wrap and the successes that start with a blank.
 */
export function parseCalls(text) {
  const lines = String(text || "").split("\n");
  const calls = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^- `([a-z_]+)`/);
    if (m) {
      if (cur) calls.push(cur);
      cur = { tool: m[1], result: [] };
      continue;
    }
    if (!cur) continue;
    if (/^#{1,3} /.test(line) || /^- \*\*/.test(line)) { calls.push(cur); cur = null; continue; }
    cur.result.push(line);
  }
  if (cur) calls.push(cur);
  return calls.map((c) => ({ tool: c.tool, result: c.result.join("\n").trim() }));
}

/**
 * Tally recent tool calls by name.
 *
 * Windowed on purpose. A tool that broke in May and was fixed in June should
 * not still be reported as broken — the question is whether it works NOW, and
 * a lifetime tally answers a different question quietly enough that nobody
 * notices it is the wrong one.
 */
export async function toolHealth({ runsDir, days = 3, now = new Date() } = {}) {
  const dir = runsDir || join(process.env.HOME || "", "cleetus-memory/runs");
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md"));
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const stamp = (f) => {
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); // run files are named in LOCAL time
  };

  const tally = new Map();
  let files = 0;
  for (const f of names) {
    const at = stamp(f);
    if (!at || at < cutoff) continue;
    files++;
    const text = await readFile(join(dir, f), "utf8").catch(() => "");
    for (const { tool, result } of parseCalls(text)) {
      const e = tally.get(tool) || { calls: 0, broken: 0, example: "" };
      e.calls++;
      if (looksBroken(result, tool)) {
        e.broken++;
        if (!e.example) e.example = result.split("\n")[0].slice(0, 110);
      }
      tally.set(tool, e);
    }
  }

  // "Every time it is called" needs more than one call to mean anything: one
  // failed call is a bad argument or a website being down, not a broken tool.
  const MIN_CALLS = 2;
  const alwaysBroken = [...tally]
    .filter(([, e]) => e.calls >= MIN_CALLS && e.broken === e.calls)
    .map(([tool, e]) => ({ tool, calls: e.calls, example: e.example }));

  return { files, days, tools: tally, alwaysBroken };
}
