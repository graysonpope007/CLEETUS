// src/tools/work.mjs — what Cleetus actually did, as opposed to what he can
// plausibly imagine having done.
//
// Asked "in two sentences, what work have you done today?", Cleetus answered:
//
//   "Today I've been helping you prepare for your meeting with Patriot McKee
//    tomorrow about GLM booking kickoff at 1000 Faces Coffee in Athens, and
//    reviewing the four venue emails sent yesterday..."
//
// None of that happened. It is Grayson's own calendar and booking history,
// injected as memory, replayed back to him as a day's work. The cause was not a
// bad answer — it was that the question had no answerable source: the run files
// are the only record of what he did, and nothing in the prompt or the toolbox
// could reach them. Thirty-five tools, and not one of them could see yesterday.
//
// Confabulation is what a model does with a question it cannot research and has
// not been told it cannot answer. This is the missing source.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "../config.mjs";
import { localStamp, ago } from "../when.mjs";

const RUNS = join(CONFIG.memoryRoot, CONFIG.runsDir || "runs");

/** Frontmatter value, without pulling in a parser for four fields. */
function field(text, name) {
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

export const workTools = {

  scheduled_jobs: {
    schema: {
      description:
        "Everything you do on a schedule without being asked: each job, what it is for, how often it " +
        "runs, when it last ran and whether that worked. Call this for 'what do you do automatically', " +
        "'what runs overnight', 'when did the brief last go out', 'is anything not running'. Do NOT " +
        "reconstruct this by reading plists — that costs twenty tool calls and still misses whether " +
        "the job actually ran.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const { JOBS, jobHistory } = await import("../jobs.mjs");
      const hist = await jobHistory().catch(() => ({}));

      // The schedule lives in launchd, not in the registry, so it is read from
      // the plist that actually governs the job — the file being the authority
      // rather than a second copy of the interval kept in sync by hand.
      const schedule = async (id) => {
        const path = join(CONFIG.home, "Library/LaunchAgents", `com.cleetus.${id}.plist`);
        const xml = await readFile(path, "utf8").catch(() => "");
        if (!xml) return "not scheduled (no launch agent)";
        const secs = (xml.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/) || [])[1];
        if (secs) {
          const n = Number(secs);
          return n % 3600 === 0 ? `every ${n / 3600}h` : `every ${Math.round(n / 60)}m`;
        }
        const times = [...xml.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)]
          .map((m) => `${String(m[1]).padStart(2, "0")}:${String(m[2]).padStart(2, "0")}`);
        return times.length ? `daily at ${times.join(" and ")}` : "scheduled (shape not recognised)";
      };

      const rows = [];
      for (const [id, j] of Object.entries(JOBS)) {
        const h = hist[id];
        rows.push(`- ${id} (${await schedule(id)}) — ${j.what}\n    last: ` +
          (h ? `${h.ok ? "ok" : "FAILED"} ${localStamp(h.at)} (${ago(h.at)})` : "never run"));
      }
      const never = rows.filter((r) => r.includes("never run")).length;
      return `${rows.length} scheduled jobs:\n${rows.join("\n")}` +
        (never ? `\n\n${never} of them have never run. That is a fact about this machine, not a guess.` : "");
    },
  },

  health_report: {
    schema: {
      description:
        "What is actually broken on this machine and in the cloud, from the doctor's own health log: " +
        "which checks are failing right now, and how long each has been failing. Call this BEFORE " +
        "answering 'is anything broken', 'are you working', 'what is wrong', 'how long has X been " +
        "down'. You cannot tell whether a check is failing by reasoning about it — the doctor runs " +
        "43 of them every fifteen minutes and this is the only record. Guessing which parts are fine " +
        "is how a real outage gets called informational.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const LOG = join(CONFIG.home, "Library/Logs/cleetus-health.log");
      const text = await readFile(LOG, "utf8").catch(() => "");
      const lines = text.trim().split("\n").filter(Boolean);
      if (!lines.length) {
        return "The health log is empty, so nothing is known about what is or is not working. " +
               "Say that rather than guessing. The job that writes it is com.cleetus.health.";
      }

      const last = lines[lines.length - 1];
      const when = (last.match(/^(\S+)/) || [])[1] || "";
      const score = (last.match(/(\d+\/\d+) ok/) || [])[1] || "?";
      const failPart = last.includes("FAIL:") ? last.slice(last.indexOf("FAIL:") + 5).trim() : "";
      const failing = failPart ? failPart.split(/\s+(?=[a-zA-Z])/).filter(Boolean) : [];

      if (!failing.length) {
        return `Everything the doctor checks is passing as of ${localStamp(when)} (${ago(when)}), ${score}.`;
      }

      // How long each has been failing: walk backwards while the name keeps
      // appearing. A check that failed yesterday, recovered, and failed again an
      // hour ago has been failing for an hour, which is the honest answer.
      const since = (name) => {
        const key = name.split("[")[0];
        let at = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes(key)) break;
          at = (lines[i].match(/^(\S+)/) || [])[1];
        }
        return at;
      };

      return `As of ${localStamp(when)} (${ago(when)}): ${score} checks passing, ${failing.length} failing.\n` +
        failing.map((f) => {
          const at = since(f);
          // Checks are NAMED FOR THEIR HEALTHY STATE — "macOS is not refusing
          // him anything", "integrations healthy". Listed as a bare failure the
          // name reads as a claim about the world, and the model repeated one
          // back as "macOS is not refusing him anything — been down since
          // yesterday", which asserts the opposite of what is happening.
          //
          // NOT TRUE makes the name a quoted proposition rather than a
          // statement, which is what it actually is.
          return `- NOT TRUE: "${f.replace(/-/g, " ")}"${at ? ` — has been false since ${localStamp(at)} (${ago(at)})` : ""}`;
        }).join("\n") +
        `\n\nEach line above is a check whose name describes the HEALTHY state, and it is currently ` +
        `false. These are real failures, not warnings. Do not describe them as informational, and do ` +
        `not repeat a check name back as though it were true.`;
    },
  },
  recent_work: {
    schema: {
      description:
        "What YOU actually did, from your own run files: the requests you handled, which agent " +
        "handled each, and whether it worked. Call this BEFORE answering anything about your own " +
        "activity — 'what have you been doing', 'what did you work on today', 'did you finish that', " +
        "'what went wrong yesterday'. You have NO other record of your own work: it is not in your " +
        "memory and not in this conversation, so answering from memory means inventing a day that did " +
        "not happen. If this returns nothing, say so plainly.",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "How far back to look. Defaults to 24." },
          limit: { type: "number", description: "How many to return, newest first. Defaults to 20." },
        },
      },
    },
    async run({ hours = 24, limit = 20 } = {}) {
      const cutoff = Date.now() - Math.max(1, Number(hours) || 24) * 3600_000;
      const files = await readdir(RUNS).catch(() => []);
      const out = [];

      for (const f of files.filter((x) => x.endsWith(".md"))) {
        const p = join(RUNS, f);
        const s = await stat(p).catch(() => null);
        if (!s || s.mtimeMs < cutoff) continue;
        const text = await readFile(p, "utf8").catch(() => "");
        // The system's own probes are not work he asked for. Including them is
        // how the weekly analysis ended up telling him he kept asking for a
        // secret he had never mentioned.
        if (/^probe:\s*true\s*$/m.test(text)) continue;
        const title = (text.match(/^# (.+)$/m) || [])[1] || f;
        out.push({
          at: s.mtimeMs,
          agent: field(text, "agent") || "cleetus",
          status: field(text, "status") || "unknown",
          request: title.slice(0, 120),
          steps: (text.match(/^- `/gm) || []).length,
        });
      }

      if (!out.length) {
        // An empty result and a broken tool must not read the same. Saying how
        // far back it looked is the difference between "nothing happened" and
        // "nothing was found", and only one of those licenses a guess.
        return `No runs in the last ${hours} hours. That means you did no work in that window — ` +
               `not that the record is missing. Do not fill the gap with things you might have done.`;
      }

      out.sort((a, b) => b.at - a.at);
      const shown = out.slice(0, Math.max(1, Number(limit) || 20));
      const head = `${out.length} run${out.length === 1 ? "" : "s"} in the last ${hours}h` +
                   (shown.length < out.length ? `, newest ${shown.length}` : "") + ":";
      return head + "\n" + shown
        .map((r) => `- ${localStamp(new Date(r.at).toISOString())} [${r.agent}] ${r.status}` +
                    `${r.steps ? `, ${r.steps} tool call${r.steps === 1 ? "" : "s"}` : ""} — ${r.request}`)
        .join("\n");
    },
  },
};
