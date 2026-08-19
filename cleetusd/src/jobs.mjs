// src/jobs.mjs — the ten scheduled jobs, rebuilt.
//
// WHAT HAPPENED TO THE ORIGINALS
// Ten launch agents pointed into /Users/grayson/cleetus/.claude/worktrees/
// naughty-fermat-4efa9a. The branch was merged on 19 May and the worktree
// emptied. launchd did exactly what it was told: respawn, file not found, exit
// 78 (EX_CONFIG), try again. com.cleetus.chat did that 423,179 times and wrote
// a 113 MB error log doing it. Nothing surfaced it for three months.
//
// The scripts are gone. Not stale — GONE: not on this disk, not in any of the
// ten repositories on the GitHub account, and the logs contain nothing but the
// same "No such file" line repeated, so not one line of their behaviour is
// recoverable either. Anybody claiming to have "restored" them is writing new
// software with an old name on it.
//
// WHAT DID SURVIVE, AND IT IS THE USEFUL HALF
// The plists. Ten labels and ten schedules — brief at 07:00, consolidate at
// 23:00, open loops at 09:00 and 15:00, brain analysis Friday at 18:00,
// heartbeat every half hour. That is a record of what Grayson wanted to happen
// and when, and it is what these are rebuilt against.
//
// SO THEY ARE REBUILT FOR THE ARCHITECTURE THAT EXISTS NOW.
// The old ones were Python against ~/cleetus/.claude, a layout that no longer
// exists either: its vault was .claude/vault and it computed that as
// Path(__file__).parents[2]/"vault". Rewriting them in place would have been
// building on a second dead foundation. These are Node, in cleetusd, using
// cleetusd's memory root, cleetusd's vault, cleetusd's agents and cleetusd's
// tools — one process, one place to debug, one doctor that already watches it.
//
// ONE RUNNER, TEN LABELS. bin/job.mjs <id> runs one job. The ten plists keep
// their own labels and schedules and simply point here, so the schedules stay
// Grayson's rather than becoming a cron table nobody edits.
//
// A JOB THAT CANNOT RUN SAYS SO. Every one of these returns {ok, summary} and
// the summary is written to jobs.log whether it worked or not. The single
// failure mode this whole file exists to prevent is a scheduled job failing
// silently for three months, and a job that reports "nothing to do" when it
// actually could not look would be the same bug in a new costume.

import { readFile, writeFile, mkdir, readdir, appendFile, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";
import { remember } from "./memory.mjs";
import { accessReport } from "./access.mjs";

import { localStamp } from "./when.mjs";
import { toolHealth } from "./toolhealth.mjs";
const RUNS = join(CONFIG.memoryRoot, CONFIG.runsDir);
const OUT = join(CONFIG.memoryRoot, "jobs");
const LOG = join(CONFIG.memoryRoot, "jobs.log");

function sh(cmd, ms = 30_000) {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", cmd], { timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000 },
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

/* Dollar amounts, in the shapes a model actually writes them: $5K, $1,200,
   $47.50, $3 million. Deliberately NOT matching a bare "$" or "$SPY" — the
   brief is allowed to name a ticker.

   Only ever used through match() and replace(). A /g regex carries lastIndex
   between .test() calls, so the same pattern tested twice answers true then
   false, which is a bug that looks like flakiness. */
// The magnitude word and the space before it are ONE optional group. Written as
// `\s?(?:...)?` instead, the space is consumed even when no magnitude follows,
// so "$1,200 out" redacts to "[amount]out".
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB]\b|million|billion|thousand))?/g;

/* A dollar amount with the dollar sign left off.
 *
 * The 07:00 brief he actually received said:
 *
 *   "Creo booked 8581 net this quarter on 8601 gross revenue"
 *
 * No `$`, so MONEY did not match, and two real figures went out. The instruction
 * is "money in percentages, never dollar figures" — and the model obeyed the
 * punctuation while ignoring the point. The same brief got the rest right:
 * "roughly one month's operating cash", "four months emergency buffer".
 *
 * A bare number is only money in context, so this needs a money WORD within a
 * few words of it. Years are excluded, and so is anything under three digits —
 * "170g of protein" and "9 to 6" are not amounts.
 */
const MONEY_WORDS = "net|gross|revenue|profit|balance|cash|paid|owed|owes|deposit|invoice|salary|" +
                    "cost|costs|price|spent|earned|booked|billed|refund|payment|payout|fee|fees";
const BARE_AMOUNT = new RegExp(
  `(?:(?:${MONEY_WORDS})\\W+(?:\\w+\\W+){0,2}(\\d[\\d,]{2,}(?:\\.\\d+)?)` +
  `|(\\d[\\d,]{2,}(?:\\.\\d+)?)\\W+(?:\\w+\\W+){0,2}(?:${MONEY_WORDS}))`,
  "gi",
);
const isYear = (n) => /^(19|20)\d\d$/.test(String(n).replace(/,/g, ""));

export const leakedMoney = (s) => {
  const text = String(s);
  const hits = text.match(MONEY) || [];
  for (const m of text.matchAll(BARE_AMOUNT)) {
    const n = m[1] || m[2];
    if (n && !isYear(n)) hits.push(n);
  }
  return hits;
};

/** Ask again, then redact whatever survives. Exported because the interesting
 *  half of this guard is the branch that only runs when the model disobeys, and
 *  waiting for that to happen on its own is not a test. `retry` is handed the
 *  offending strings and returns a second attempt. */
export async function scrubMoney(answer, retry) {
  const leaks = leakedMoney(answer);
  if (!leaks.length) return { text: answer, redacted: 0 };

  const second = String((await retry(leaks)) || "");
  if (second.trim() && !leakedMoney(second).length) return { text: second, redacted: 0 };

  // Keep whichever attempt leaked less, then redact it. A retry that came back
  // worse (or empty) is discarded rather than trusted for being newer.
  const best = second.trim() && leakedMoney(second).length < leaks.length ? second : answer;
  // Redact both forms. Redacting only the $-prefixed one would count a bare
  // figure as a leak, report it as redacted, and leave it in the text — the
  // worst of the three possible outcomes, because the summary would say it had
  // been handled.
  const scrubbed = best
    .replace(MONEY, "[amount]")
    .replace(BARE_AMOUNT, (m, a, b) => m.replace(a || b, "[amount]"));
  return { text: scrubbed, redacted: leakedMoney(best).length };
}

/** Everything these write lands in ~/cleetus-memory/jobs, as markdown. */
async function write(name, body) {
  await mkdir(OUT, { recursive: true });
  const path = join(OUT, name);
  await writeFile(path, body, "utf8");
  return path;
}

/**
 * Runs the improve loop has since resolved.
 *
 * improve.mjs keys its history by `run:<filename>` and records what came of the
 * attempt. Three of those outcomes mean the question is genuinely closed:
 * it re-ran the original question and got a good answer, or it found the cause
 * already fixed. Nothing else does.
 *
 * The matching is deliberately narrow. "shipped" is NOT resolution — section
 * 118 is about exactly that: a change shipped for push while push stayed down,
 * and the outcome string now says so. Anything still failing is excluded by
 * name rather than by hoping the word "fixed" is absent.
 *
 * A missing or unreadable state file returns an empty set, so the worst case is
 * the old behaviour: everything stays listed. Never the other way round — a
 * parse error must not quietly empty Grayson's worklist.
 */
export async function resolvedRunKeys(stateFile = join(CONFIG.memoryRoot, "improve-state.json")) {
  const out = new Set();
  try {
    const s = JSON.parse(await readFile(stateFile, "utf8"));
    for (const h of s.history || []) {
      const key = String(h.key || "");
      if (!key.startsWith("run:")) continue;
      const outcome = String(h.outcome || "").toLowerCase();
      if (!/fixed/.test(outcome)) continue;
      if (/still failing|failed|revert/.test(outcome)) continue;
      out.add(key.slice(4));
    }
  } catch { /* no state, or unreadable: list everything, which is the safe direction */ }
  return out;
}

/** Runs from the last N hours, newest first. The raw material for most of these.
 *
 *  Probe runs are excluded. These files feed the weekly analysis and the nightly
 *  consolidation — one decides what Cleetus should change about himself, the
 *  other promotes facts into MEMORY.md — so a health check or a security test
 *  landing in here does not merely add noise: it gets read back as something
 *  Grayson did, and reasoned about. The weekly analysis said "You keep asking me
 *  to find DOCTOR_PROBE_KEY and paste it into forms" about a request he never
 *  made. */
async function recentRunFiles(hours, { includeProbes = false } = {}) {
  const cutoff = Date.now() - hours * 3600_000;
  // "Could not look" and "nothing to see" must not produce the same answer.
  //
  // This used to be `readdir(RUNS).catch(() => [])`, and the header of this file
  // forbids exactly that: "a job that reports 'nothing to do' when it actually
  // could not look would be the same bug in a new costume." Four jobs read this
  // helper. If the runs directory were renamed, moved, or lost its permissions,
  // every one of them would report a cheerful nothing — consolidation "nothing
  // durable", open loops "Nothing open", the weekly analysis a blank week — and
  // the whole system would look idle and healthy while being blind.
  //
  // Throwing is the right shape rather than returning a flag, because bin/job.mjs
  // already turns a thrown job into a FAIL line in jobs.log, and the doctor's
  // "the scheduled jobs are working" check reads that log. So the failure
  // surfaces by the route built for it, named, instead of being invented as a
  // fifth silent path.
  let names;
  try {
    names = await readdir(RUNS);
  } catch (e) {
    throw new Error(`cannot read the runs directory ${RUNS} (${e.code || e.message}) — this is not an empty day, it is a blind one`);
  }
  const files = names.filter((f) => f.endsWith(".md"));
  const out = [];
  for (const f of files) {
    const p = join(RUNS, f);
    const s = await stat(p).catch(() => null);
    if (!s || s.mtimeMs < cutoff) continue;
    const text = await readFile(p, "utf8").catch(() => "");
    if (!includeProbes && /^probe:\s*true\s*$/m.test(text)) continue;
    out.push({ file: f, path: p, at: s.mtimeMs, text });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Ask the local model, in-process.
 *
 * Imported lazily because agent.mjs pulls in the whole tool registry, the
 * ollama client and the teacher — a couple of seconds of startup that the four
 * jobs which never touch the model should not pay for. `reindex` runs every
 * fifteen minutes.
 */
/**
 * A job asking the model something is the system talking to ITSELF, so every one
 * of these is a probe.
 *
 * Without the marker the loop closes on itself: nightly-consolidation reads the
 * day's runs, and its own question — "Here is everything you did for Grayson
 * today" with the whole digest pasted in — becomes one of tomorrow's runs, to be
 * read as something Grayson said. brain-analysis had already done exactly this,
 * and its run had to be marked by hand after the fact. Marking it here is the
 * source fix; marking the files was the cleanup.
 */
/**
 * Every one of these is read and not replied to.
 *
 * The first pre-event brief ever written ended "Would you like me to check the
 * calendar API, or search more broadly for this?" — addressed to a markdown file
 * on his disk. The morning brief and the weekly analysis go out through the same
 * agent and the same one-way channel and had no such instruction; neither has
 * asked a question in the runs on record, but the tendency is the agent's, not
 * the job's.
 *
 * One constant rather than three copies, because this session has now found the
 * tool list, the agent grouping and the "Last updated" header each kept by hand
 * beside something that maintains itself, and each one drifted.
 */
const ONE_WAY =
  "\nThis is a one-way note. He reads it and cannot reply, so do not ask him anything, " +
  "do not offer to do more, and do not end on a question. End on the last useful fact.";

async function askModel(question, agent) {
  const { ask } = await import("./agent.mjs");
  // Scheduled work, with nobody watching a chat box for it. The interactive
  // eight-minute deadline is the wrong bound here — see CONFIG.turnDeadlineMs —
  // so these run to the step budget like they always have.
  const out = await ask({ history: [{ role: "user", content: question }], agent, probe: true, deadlineMs: 0 });
  return out.answer || "";
}

// ── the jobs ────────────────────────────────────────────────────────────────

export const JOBS = {
  /* Every 30 minutes. The tick that notices things.
     Deliberately does NOT call the model: it runs 48 times a day, and a job
     that costs a 33B inference every half hour to usually say "nothing" is a
     job that gets switched off. It gathers, and it only writes when something
     is actually up. */
  heartbeat: {
    what: "Notices what needs attention: failed work, health failures, imminent dates.",
    async run() {
      const flags = [];

      // Work that failed. The run files already record this and nothing was
      // reading them, so a failed task simply never came up again.
      const runs = await recentRunFiles(24);
      const failed = runs.filter((r) => /^status:\s*failed\s*$/m.test(r.text));
      if (failed.length) {
        flags.push(`${failed.length} task${failed.length === 1 ? "" : "s"} failed in the last 24h:\n` +
          failed.slice(0, 5).map((r) => `  - ${(r.text.match(/^# (.+)$/m) || [])[1] || r.file}`).join("\n"));
      }

      // The doctor's own verdict, which until now lived only on a web panel
      // somebody had to have open.
      try {
        const d = await fetch("http://127.0.0.1:8767/doctor", { signal: AbortSignal.timeout(90_000) })
          .then((r) => r.json());
        if (d.failed?.length) {
          // Two fixes made elsewhere and missed here.
          //
          // Check names describe the HEALTHY state — "macOS is not refusing him
          // anything", "integrations healthy" — so listed as bare failures they
          // read as statements about the world. This file said "macOS is not
          // refusing him anything (since 15:09)", which asserts the opposite of
          // what it means. NOT TRUE makes it the proposition it actually is.
          //
          // And the timestamps were raw ISO in UTC while the heading two lines
          // above was already local, so a failure that started at 11:09 read as
          // 15:09 in a file with the right time at the top of it.
          flags.push(`${d.failed.length} health check${d.failed.length === 1 ? "" : "s"} failing:\n` +
            d.failed.map((f) => `  - ${f.area}: NOT TRUE that "${f.name}"` +
                                `${f.since ? ` (false since ${localStamp(f.since)})` : ""}`).join("\n"));
        }
      } catch (e) {
        flags.push(`the doctor did not answer (${e.message})`);
      }

      // Dates coming up, out of the vault. The skills that key off "heartbeat
      // detects a date within 14 days" have had nothing to key off since May.
      const vaultDates = await imminentVaultDates(14);
      if (vaultDates.length) {
        flags.push(`dates within 14 days:\n` + vaultDates.map((d) => `  - ${d}`).join("\n"));
      }

      const body = flags.length
        ? `# Heartbeat ${localStamp(new Date().toISOString())}\n\n${flags.join("\n\n")}\n`
        : "";
      if (body) await write("heartbeat.md", body);
      return { ok: true, summary: flags.length ? `${flags.length} thing(s) flagged` : "nothing to flag" };
    },
  },

  /* 07:00. The morning brief.
     NOT the brief Grayson reads on the site — that one is the cloud app's, it
     lives in the database and has been healthy throughout. Worth stating
     because the first diagnosis of this outage assumed otherwise and sent
     everyone looking in the wrong place. This is the local one, written into
     the vault where Obsidian picks it up. */
  briefing: {
    what: "Writes the morning brief into the vault, using the brief agent.",
    async run() {
      const ask =
        "Write this morning's brief for Grayson. Use your tools to get the real numbers rather than " +
        "guessing: today's calendar, the weather where he actually is, what training is due, and " +
        "anything you flagged in ~/cleetus-memory/jobs/heartbeat.md. Money in percentages, never " +
        "dollar figures. Plain text, no headings, no lists." + ONE_WAY;
      let answer = await askModel(ask, "brief");
      if (!answer.trim()) return { ok: false, summary: "the model returned nothing" };

      // "Money in percentages, never dollar figures" is an instruction, and an
      // instruction is not a guarantee. The very first run of this job that
      // anyone read shipped "roughly $5K across accounts" — the percentage rule
      // held for the position sizes in the same sentence and broke on the cash.
      // This brief syncs through iCloud and gets read on a phone at 7am, so the
      // rule is his, not a house style.
      //
      // Retry once with the offending text quoted back, since the model is
      // capable of obeying and mostly does. If the retry still leaks, redact and
      // SAY SO in the summary: a brief with a visible redaction is more use at
      // 7am than no brief, and a silent redaction is how a rule quietly rots.
      const scrubbed = await scrubMoney(answer, (leaks) =>
        askModel(
          `${ask}\n\nYour previous attempt contained ${leaks.join(", ")}. That is exactly what you ` +
          "must not write. Give the same brief with every amount as a percentage, a comparison, or " +
          "left out.",
          "brief",
        ));
      answer = scrubbed.text;
      const redacted = scrubbed.redacted;

      const day = stampDay();
      await write(`brief-${day}.md`, `# Brief ${day}\n\n${answer}\n`);
      // Also into the vault, if it is reachable from here. Under launchd it
      // often is not (iCloud does not serve daemons), and that is a degraded
      // result rather than a failure — the copy in the memory root is the one
      // that always exists.
      const vaultPath = join(CONFIG.vault, "10-Daily", `${day}.md`);
      const landed = await appendFile(vaultPath, `\n\n## Morning brief\n\n${answer}\n`, "utf8")
        .then(() => true).catch(() => false);
      const note = redacted ? `, ${redacted} dollar figure${redacted === 1 ? "" : "s"} redacted` : "";
      return { ok: true, summary: `brief written${landed ? " and appended to the daily note" : " (vault unreachable, memory root only)"}${note}` };
    },
  },

  /* 23:00. Turn the day's work into things worth keeping.
     The runs are already an append-only record of everything Cleetus did. What
     was missing is anything reading them: a fact he learned at 11am was in a
     run file and nowhere else by midnight. */
  "nightly-consolidation": {
    what: "Reads the day's runs and promotes anything durable into MEMORY.md.",
    async run() {
      const runs = await recentRunFiles(24);
      if (!runs.length) return { ok: true, summary: "no runs today, nothing to consolidate" };
      const digest = runs.slice(0, 25)
        .map((r) => r.text.slice(0, 1800))
        .join("\n\n---\n\n")
        .slice(0, 40_000);

      const answer = await askModel(
        `Here is everything you did for Grayson today, as your own run files.\n\n${digest}\n\n` +
        // The escape hatch goes LAST, and it has to cost something to take.
        //
        // The previous wording ended "If there is nothing durable, reply with
        // exactly: NOTHING", and the model took that exit almost every time.
        // Measured against a digest containing "I switched from the Fender
        // P-Bass to a Music Man StingRay" and "I decided to drop my protein
        // target from 200g to 170g" — neither missable:
        //
        //   old wording    extracted on 1 of 7 runs
        //   this wording   extracted on 4 of 4
        //
        // So this job had effectively never worked. It ran nightly, reported
        // "ok, nothing durable", and promoted almost nothing — for the same
        // reason the empty-dossier prompt in agent.mjs had to be rewritten: a
        // get-out clause in a prompt WILL be used.
        //
        // "One per line" is also load-bearing. On the runs where the old wording
        // did produce something, it returned both facts merged into a single
        // sentence, which becomes one unsearchable line in MEMORY.md forever.
        "Read every line above and find the places where Grayson states something about himself, " +
        "makes a decision, or changes something. Write each one as a single durable fact: a " +
        "complete sentence that will still make sense in six months, naming him rather than saying " +
        "'he told me'. Output ONLY those sentences, one per line — no quotes, no preamble, no " +
        "numbering, no commentary.\n" +
        "If and only if you have read it all and there is genuinely nothing of that kind, reply " +
        "with exactly: NOTHING",
        "cleetus",
      );

      if (/^\s*NOTHING\s*$/i.test(answer)) {
        return { ok: true, summary: `${runs.length} runs, nothing durable` };
      }
      // "One per line" is an instruction, and an instruction is not a guarantee:
      // on one run in three the model returns both facts in a single sentence
      // pair, which becomes one long unsearchable line in MEMORY.md forever.
      //
      // Split on a full stop followed by a capital, which is the same rule
      // endsOnAPromise uses and for the same reason — it leaves "170g." and
      // "health.js" intact because what follows them is not a capital letter.
      const perLine = answer.split("\n")
        .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z])/))
        .map((l) => l.trim());
      const candidates = perLine.map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
        .filter((l) => l.length > 15 && l.length < 400);

      // A ceiling, because this runs every night forever and writes into the file
      // every agent reads on every message. A model returning forty lines on one
      // busy day would put forty lines in MEMORY.md, and nothing downstream ever
      // takes them out again. Twelve is generous for a single day of genuinely
      // durable facts; the point is that there is a bound at all.
      //
      // What gets dropped is written down rather than swallowed. A silent cap
      // reads as "that was everything worth keeping", which is the one thing it
      // is not — and if this fires regularly the prompt is wrong, not the limit.
      const MAX_FACTS = 12;
      const facts = candidates.slice(0, MAX_FACTS);
      const dropped = candidates.slice(MAX_FACTS);

      for (const f of facts) await remember(f, { source: "nightly consolidation" }).catch(() => {});
      await write(`consolidation-${stampDay()}.md`,
        `# Consolidation ${stampDay()}\n\n${runs.length} runs reviewed.\n\n${facts.map((f) => `- ${f}`).join("\n")}\n` +
        (dropped.length
          ? `\n## Over the ${MAX_FACTS}-fact limit, NOT remembered\n\n${dropped.map((f) => `- ${f}`).join("\n")}\n`
          : ""));
      return {
        ok: true,
        summary: `${runs.length} runs, ${facts.length} fact(s) kept` +
                 (dropped.length ? ` — ${dropped.length} over the ${MAX_FACTS} cap, listed in the consolidation file but NOT remembered` : ""),
      };
    },
  },

  /* Hourly, and at load. Memory into the vault.
     cleetusd writes to ~/cleetus-memory ON PURPOSE — iCloud blocks a launchd
     daemon uncancellably, so putting the daemon's own memory behind it means a
     personal assistant that stops working because a sync daemon is thinking
     (see config.mjs). The cost of that decision is that none of it appears in
     Obsidian, which is where Grayson actually reads. This pays that cost off on
     a schedule instead of in the request path: it copies, it never moves, and
     if the vault is blocked it says so and tries again in an hour. */
  "vault-sync": {
    what: "Copies memory, skills and job output into the Obsidian vault.",
    async run() {
      const dest = join(CONFIG.vault, "30-Projects", "Cleetus", "memory");
      const reachable = await mkdir(dest, { recursive: true }).then(() => true).catch(() => false);
      if (!reachable) {
        return { ok: false, summary: "the vault is not writable from here (iCloud does not serve launchd agents)" };
      }
      let copied = 0;
      for (const sub of ["", CONFIG.skillsDir, "jobs", "agents"]) {
        const from = sub ? join(CONFIG.memoryRoot, sub) : CONFIG.memoryRoot;
        const to = sub ? join(dest, sub) : dest;
        await mkdir(to, { recursive: true }).catch(() => {});
        for (const f of (await readdir(from).catch(() => []))) {
          if (!f.endsWith(".md")) continue;
          // Only when the source is newer. Rewriting forty identical files
          // every hour makes iCloud resync all of them, which is how a sync job
          // becomes the reason the vault is busy.
          const [a, b] = await Promise.all([stat(join(from, f)).catch(() => null), stat(join(to, f)).catch(() => null)]);
          if (!a || (b && b.mtimeMs >= a.mtimeMs)) continue;
          if (await copyFile(join(from, f), join(to, f)).then(() => true).catch(() => false)) copied++;
        }
      }
      return { ok: true, summary: copied ? `${copied} file(s) copied into the vault` : "vault already up to date" };
    },
  },

  /* Every 15 minutes. A keyword index over everything Cleetus knows.
     Searching used to mean walking every markdown file and reading all of them,
     per query. That is fine at today's size and it is not fine at next year's,
     and it is paid in the request path where Grayson is waiting. No model, no
     network — this is a few hundred file reads and a JSON write. */
  reindex: {
    what: "Rebuilds the keyword index over runs, skills and conversations.",
    async run() {
      const index = { built_at: new Date().toISOString(), docs: [] };
      const sources = [
        ["run", RUNS],
        ["skill", join(CONFIG.memoryRoot, CONFIG.skillsDir)],
        ["conversation", join(CONFIG.memoryRoot, "conversations")],
        ["agent-memory", join(CONFIG.memoryRoot, "agents")],
      ];
      for (const [kind, dir] of sources) {
        for (const f of (await readdir(dir).catch(() => []))) {
          if (!/\.(md|json)$/.test(f)) continue;
          const text = await readFile(join(dir, f), "utf8").catch(() => "");
          if (!text) continue;

          // Half of the runs on disk are probes — the system testing itself.
          // Indexing them puts this session's own test traffic into the corpus
          // that gets searched when he asks a question, so a search for
          // "breakouts" can surface a run that only exists because something was
          // being verified. Measured at the time of writing: 47 of 93.
          if (kind === "run" && /^probe:\s*true\s*$/m.test(text)) continue;
          const words = new Set((text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).slice(0, 4000));
          index.docs.push({
            kind, file: f, path: join(dir, f),
            title: (text.match(/^#\s*(.+)$/m) || text.match(/"title"\s*:\s*"([^"]+)"/) || [])[1] || f,
            at: (await stat(join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
            terms: [...words].slice(0, 600),
          });
        }
      }
      await mkdir(CONFIG.memoryRoot, { recursive: true });
      await writeFile(join(CONFIG.memoryRoot, "index.json"), JSON.stringify(index), "utf8");
      return { ok: true, summary: `${index.docs.length} document(s) indexed` };
    },
  },

  /* 09:00 and 15:00. What has been started and not finished.
     Three sources, because a loop stays open in three different places and
     only one of them was ever visible. */
  "open-loops": {
    what: "Lists unfinished work: failed runs, questions Cleetus asked, browser actions waiting on approval.",
    async run() {
      const loops = [];

      // One line per QUESTION, not per attempt.
      //
      // Asking the same thing four times because it keeps failing is one open
      // loop, and it was being listed four times: "can you fix studio locate"
      // appeared twice in a seven-item list, "how much can you actually edit
      // your own code" twice more. Five real items padded to seven, with the
      // repeats pushing distinct ones off the end of what he reads.
      //
      // findWork() in improve.mjs had exactly this and was fixed the same way —
      // its comment reads "Five identical stack lines are one bug, not five."
      //
      // The repeat count is kept rather than dropped: four failures of the same
      // question is a stronger signal than one, and losing it would trade one
      // wrong impression for another.
      // Two systems knew different things and neither told the other.
      //
      // A run file records `status: failed` once and keeps it forever, so a
      // question stays on this list for the full seven days no matter what
      // happens afterwards. Meanwhile the improve loop had picked up six of
      // these, RE-RUN the original questions, and recorded "verified fixed" —
      // and this list went on showing all six as open work. Grayson reads this
      // file; improve's state file is read by nobody.
      //
      // Resolved ones are dropped rather than annotated, because this is a list
      // of what is OPEN. But the count is kept and printed at the bottom: an
      // item vanishing silently from a worklist is its own small betrayal, and
      // "three of these were re-run and answered" is the part that makes a
      // suddenly shorter list believable.
      const resolved = await resolvedRunKeys();
      const runs = await recentRunFiles(24 * 7);
      const seen = new Map();
      let cleared = 0;
      for (const r of runs) {
        const title = (r.text.match(/^# (.+)$/m) || [])[1] || r.file;
        let kind = null;
        if (/^status:\s*failed\s*$/m.test(r.text)) kind = "FAILED";
        else if (/\[(Stopped here after \d+ tool calls|Answered from partial information)/.test(r.text)) kind = "UNFINISHED";
        if (!kind) continue;
        if (resolved.has(r.file)) { cleared++; continue; }
        const key = `${kind}·${title}`;
        seen.set(key, { kind, title, n: (seen.get(key)?.n || 0) + 1 });
      }
      for (const { kind, title, n } of seen.values()) {
        loops.push(`${kind}${n > 1 ? ` ×${n}` : ""} · ${title}`);
      }

      // Questions he was asked and has not answered. A specialist told to ask
      // for one missing fact does exactly that and then waits forever, because
      // nothing was tracking that it was waiting.
      const convDir = join(CONFIG.memoryRoot, "conversations");
      for (const f of (await readdir(convDir).catch(() => []))) {
        if (!f.endsWith(".json")) continue;
        try {
          const c = JSON.parse(await readFile(join(convDir, f), "utf8"));
          const last = c.messages?.[c.messages.length - 1];
          if (last?.role === "assistant" && typeof last.content === "string" && last.content.includes("?")
              && Date.now() - Date.parse(c.updated) > 12 * 3600_000) {
            loops.push(`WAITING ON YOU · ${c.title} (${c.agent}, ${String(c.updated).slice(0, 10)})`);
          }
        } catch {}
      }

      // Anything the browser harness is holding. These are irreversible actions
      // that stopped and queued for a human yes, which is the whole point of
      // the harness and also the easiest thing in the system to forget about.
      try {
        const d = await fetch(`${CONFIG.webHarness}/api/pending`, { signal: AbortSignal.timeout(4000) })
          .then((r) => r.json());
        for (const p of d.pending || []) loops.push(`NEEDS YOUR YES · ${p.summary} (${p.url})`);
      } catch { /* the harness being down is not an open loop */ }

      const footer = cleared
        ? `\n${cleared} earlier failure${cleared === 1 ? " was" : "s were"} re-run and answered since, so ${cleared === 1 ? "it is" : "they are"} not listed.\n`
        : "";
      const body = loops.length
        ? `# Open loops ${stampDay()}\n\n${loops.map((l) => `- ${l}`).join("\n")}\n${footer}`
        : `# Open loops ${stampDay()}\n\nNothing open.\n${footer}`;
      await write("open-loops.md", body);
      return { ok: true, summary: loops.length ? `${loops.length} open` : "nothing open", cleared };
    },
  },

  /* Every 10 minutes. Say something useful before he walks into a room.
     The window is 15 to 45 minutes out. Sooner than that and he is already
     moving; further out and he will have forgotten it by the time it matters. */
  "pre-event-brief": {
    what: "Briefs the next calendar event, 15 to 45 minutes before it starts.",
    async run() {
      let events;
      try {
        const { TOOLS } = await import("./tools/index.mjs");
        const raw = await TOOLS.cloud_api.run({ path: "/api/google/calendar" });
        // /api/google/calendar answers with a BARE ARRAY. This looked for
        // `.events` and then `.items`, found neither on an array, and fell
        // through to [] — every single time, since the job was written.
        //
        // So the filter always ran over nothing, the job always reported
        // "nothing starting in the next 45 minutes", and it always looked fine:
        // that sentence is exactly what a correct run says on a quiet evening.
        // Every ten minutes, for months, about a calendar with events in it.
        //
        // The object forms are kept because a wrapped response is the more
        // common shape and this may not be the only endpoint it ever reads.
        const parsed = JSON.parse(raw);
        events = Array.isArray(parsed) ? parsed : (parsed.events || parsed.items || []);
      } catch (e) {
        return { ok: false, summary: `could not read the calendar: ${e.message}` };
      }

      const now = Date.now();
      // A pre-event brief is for a meeting you walk INTO, not a day you are
      // already inside. "Creo" is a nine-hour work block, 09:00 to 18:00, every
      // weekday — briefing it fires daily and has nothing to say, which is how a
      // useful notification becomes one he swipes away without reading.
      const LONG_HOURS = Number(process.env.CLEETUSD_EVENT_MAX_HOURS || 4);
      const isBlock = (e) => {
        const a = Date.parse(e.start?.dateTime || e.start || e.when || "");
        const b = Date.parse(e.end?.dateTime || e.end || "");
        return a && b && (b - a) > LONG_HOURS * 3600_000;
      };

      const soon = events.filter((e) => {
        if (isBlock(e)) return false;
        const t = Date.parse(e.start?.dateTime || e.start || e.when || "");
        return t && t - now > 15 * 60_000 && t - now < 45 * 60_000;
      });
      if (!soon.length) return { ok: true, summary: "nothing starting in the next 45 minutes" };

      // Briefed once. Without this it fires every ten minutes for half an hour,
      // which is three identical briefs and the reason people mute things.
      const seenPath = join(OUT, ".briefed.json");
      const seen = await readFile(seenPath, "utf8").then(JSON.parse).catch(() => ({}));
      const fresh = soon.filter((e) => !seen[e.id || e.summary]);
      if (!fresh.length) return { ok: true, summary: `${soon.length} event(s) already briefed` };

      const ev = fresh[0];
      const answer = await askModel(
        `Grayson has "${ev.summary || ev.title}" starting in about half an hour` +
        `${ev.location ? ` at ${ev.location}` : ""}. Search the vault for the people and the place ` +
        `involved and tell him what he needs to walk in knowing. Four sentences at most. If you find ` +
        `nothing about it, say that plainly rather than padding.\n` +
        // This is a notification, not a conversation. The first one ever written
        // ended "Would you like me to check the calendar API, or search more
        // broadly?" — addressed to a file nobody is going to reply to. An
        // unanswerable question is padding wearing a helpful expression.
        ONE_WAY,
        "brief",
      );
      seen[ev.id || ev.summary] = Date.now();
      await mkdir(OUT, { recursive: true });
      await writeFile(seenPath, JSON.stringify(seen), "utf8");
      await write("next-event.md", `# ${ev.summary || ev.title}\n\n${answer}\n`);
      return { ok: true, summary: `briefed "${ev.summary || ev.title}"` };
    },
  },

  /* Every 10 minutes. Texts.
     THIS ONE CANNOT WORK YET AND SAYS SO. ~/Library/Messages is behind Full
     Disk Access and this process does not have it, so chat.db cannot be opened
     at all. That is a switch in System Settings, not a bug in this file, and
     the job reports the denial as the denial rather than as "no new messages" —
     which is the same sentence and the opposite meaning. */
  "text-monitor": {
    what: "Watches iMessage for anything that needs a reply. Needs Full Disk Access.",
    async run() {
      const db = join(CONFIG.home, "Library/Messages/chat.db");
      if (!existsSync(db)) return { ok: false, summary: "there is no Messages database on this Mac" };

      // Apple epoch is 2001-01-01 in nanoseconds. Read-only, and via a copy of
      // the URI so a live WAL cannot block the read.
      const since = Math.floor((Date.now() - 3600_000) / 1000) - 978_307_200;
      const q =
        `SELECT h.id, m.text, m.is_from_me FROM message m ` +
        `JOIN handle h ON m.handle_id = h.ROWID ` +
        `WHERE m.date/1000000000 > ${since} AND m.text IS NOT NULL ORDER BY m.date DESC LIMIT 40;`;
      const r = await sh(`/usr/bin/sqlite3 -readonly ${JSON.stringify(db)} ${JSON.stringify(q)}`, 20_000);

      if (!r.ok || /authorization denied|unable to open/i.test(r.err)) {
        const a = await accessReport();
        return {
          ok: false,
          summary: `macOS is refusing this process the Messages database. This is not "no messages" — ` +
            `it is Full Disk Access, which is off for ${a.running_as}. ` +
            (a.fix?.steps || []).join(" "),
        };
      }
      const lines = r.out.split("\n").filter(Boolean);
      const incoming = lines.filter((l) => !/\|1$/.test(l));
      if (!incoming.length) return { ok: true, summary: "no incoming texts in the last hour" };
      await write("texts.md",
        `# Texts in the last hour\n\n${incoming.map((l) => `- ${l.replace(/\|0$/, "")}`).join("\n")}\n`);
      return { ok: true, summary: `${incoming.length} incoming text(s)` };
    },
  },

  /* Friday 18:00. The week, looked at rather than logged.
     Weekly on purpose: the interesting things here are trends, and a trend is
     not visible in a day. */
  "brain-analysis": {
    what: "Weekly: what Cleetus was asked for, what he got wrong, what is worth changing.",
    async run() {
      const runs = await recentRunFiles(24 * 7);
      if (runs.length < 3) return { ok: true, summary: `only ${runs.length} runs this week, not enough to analyse` };
      const failed = runs.filter((r) => /^status:\s*failed\s*$/m.test(r.text));
      const byAgent = {};
      for (const r of runs) {
        const a = (r.text.match(/^agent:\s*(.+)$/m) || [])[1] || "cleetus";
        byAgent[a] = (byAgent[a] || 0) + 1;
      }
      const digest = runs.slice(0, 40).map((r) => {
        const title = (r.text.match(/^# (.+)$/m) || [])[1] || r.file;
        const status = (r.text.match(/^status:\s*(.+)$/m) || [])[1] || "done";
        return `- [${status}] ${title}`;
      }).join("\n");

      // It was being asked what it did wrong while being shown only the QUESTIONS.
      //
      // The digest is titles and statuses. Nothing about which tools ran or what
      // came back. Asked "where are you falling down" against that, the model has
      // no evidence and produces a mechanism anyway — on 14 Aug it concluded "you
      // are not actually looking at the camera output, you are just saying you
      // cannot see images", and recommended it stop claiming limitations and call
      // `look` and `who_is_there`. Both had been called five times that week, and
      // both cameras were off the USB bus, so the advice was to assert a
      // capability the machine did not have. That is the invented-desk failure
      // wearing a different hat.
      //
      // The tally is cheap and comes from the same run files, so the question
      // becomes answerable from evidence instead of from the shape of the
      // questions. What it cannot see is stated too — a model told the limits of
      // its evidence is far less likely to fill them in.
      const th = await toolHealth({ days: 7 });
      const usage = [...th.tools].sort((a, b) => b[1].calls - a[1].calls).slice(0, 18)
        .map(([t, e]) => `  ${t}: ${e.calls} call${e.calls === 1 ? "" : "s"}${e.broken ? `, ${e.broken} failed` : ""}`)
        .join("\n");

      const answer = await askModel(
        `This is a week of your own work for Grayson.\n\n` +
        `${runs.length} tasks, ${failed.length} failed.\n` +
        `By agent: ${Object.entries(byAgent).map(([a, n]) => `${a} ${n}`).join(", ")}\n\n${digest}\n\n` +
        (usage
          ? `Tools you actually called this week, counted from your own run files:\n${usage}\n\n` +
            `Use these counts. Do not claim you failed to call a tool that appears above, and do not ` +
            `recommend calling one you already call often — that advice has been wrong before.\n\n`
          : "") +
        `You are seeing the QUESTIONS and the tool counts, not the answers you gave. Do not assert why ` +
        `something went wrong unless the evidence above shows it; say what you cannot tell from here.\n\n` +
        // Adding the tool counts stopped the invented mechanism and did not stop
        // invention. The next run closed with "The desk light is currently at
        // 2700K warm white, 50% brightness — on" — a live hardware reading, in a
        // weekly retrospective, produced by no tool call at all. It also decided
        // studio-locate "isn't broken" while its camera check was red.
        //
        // This job runs with no tools and reads a list of old titles. Every
        // sentence about how anything is RIGHT NOW is therefore invented by
        // definition, which makes it the one thing worth forbidding outright
        // rather than hoping better evidence crowds it out.
        `You have no tools here and you cannot see the machine. Say NOTHING about the current state of ` +
        `any device, service, camera, light or file — not whether something is on, off, working or broken. ` +
        `Anything you write in that form is invented. Write only about the week in the list above.\n\n` +
        `Answer three things, plainly, in a short paragraph each: what he actually keeps asking you ` +
        `for, where you are falling down, and the ONE change to yourself that would help him most. ` +
        `Be specific and be hard on yourself. Do not summarise the list back to me.` + ONE_WAY,
        "cleetus",
      );
      await write(`brain-analysis-${stampDay()}.md`,
        `# Weekly analysis ${stampDay()}\n\n${runs.length} tasks, ${failed.length} failed.\n\n${answer}\n`);
      return { ok: true, summary: `${runs.length} runs analysed, ${failed.length} failed` };
    },
  },

  /* Was a KeepAlive Python chat server on its own port.
     Cleetusd IS that server now, and has been since it was written: same job,
     same machine, plus the disk, the shell, the vault and the agents. Standing
     a second chat service back up would give Grayson two Cleetuses with
     different memories, which is worse than having none.
     So this label keeps its plist and changes what it does: it watches the
     service that replaced it. That is the original intent — keep the chat
     alive — expressed against the thing that is actually running. */
  chat: {
    what: "Watchdog for the chat service that replaced this one: cleetusd itself.",
    async run() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const h = await fetch("http://127.0.0.1:8767/health", { signal: AbortSignal.timeout(8000) })
            .then((r) => r.json());
          if (h.ok) return { ok: true, summary: `cleetusd is answering on ${h.model}` };
          // Answering but unhealthy is usually Ollama, not the daemon, and
          // kickstarting cleetusd for that would be a restart loop that fixes
          // nothing.
          return { ok: false, summary: `cleetusd answers but reports unhealthy: ${h.ollama?.detail || "unknown"}` };
        } catch (e) {
          if (attempt) return { ok: false, summary: `cleetusd did not come back: ${e.message}` };
          await sh(`launchctl kickstart -k gui/$(id -u)/com.cleetus.cleetusd`, 15_000);
          await new Promise((r) => setTimeout(r, 6000));
        }
      }
      return { ok: false, summary: "unreachable" };
    },
  },
};

/**
 * Dates in the vault worth knowing about.
 *
 * Deliberately dumb: an ISO date in any note, inside the window. A birthday
 * written as "Dec 20" is not caught and that is fine — this is the cheap half
 * of noticing, and the skills that read it do the reasoning.
 */
async function imminentVaultDates(days) {
  const out = [];
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86400_000);
  const walk = async (dir, depth = 0) => {
    if (depth > 3 || out.length > 20) return;
    for (const e of (await readdir(dir, { withFileTypes: true }).catch(() => []))) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!e.name.endsWith(".md")) continue;
      const text = await readFile(p, "utf8").catch(() => "");
      for (const m of text.matchAll(/(\d{4}-\d{2}-\d{2})/g)) {
        const d = new Date(m[1] + "T12:00:00");
        if (d >= now && d <= horizon) {
          const line = text.slice(Math.max(0, m.index - 90), m.index + 40).split("\n").pop().trim();
          out.push(`${m[1]} — ${line.slice(0, 100)} (${e.name})`);
          break;
        }
      }
    }
  };
  await walk(CONFIG.vault);
  return out.slice(0, 8);
}

/** Run one, and write down that it ran. Never throws. */
export async function runJob(id) {
  const job = JOBS[id];
  if (!job) return { ok: false, id, summary: `no job called "${id}". Known: ${Object.keys(JOBS).join(", ")}` };
  const started = Date.now();
  let result;
  try {
    result = await job.run();
  } catch (e) {
    result = { ok: false, summary: `threw: ${e.message}` };
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const line = `${new Date().toISOString()} ${result.ok ? "ok  " : "FAIL"} ${id} (${secs}s) ${result.summary}\n`;
  await mkdir(CONFIG.memoryRoot, { recursive: true }).catch(() => {});
  await appendFile(LOG, line, "utf8").catch(() => {});
  return { ...result, id, seconds: Number(secs) };
}

/** For the doctor: when did each job last run, and did it work? */
export async function jobHistory() {
  const text = await readFile(LOG, "utf8").catch(() => "");
  const last = {};
  for (const line of text.split("\n").filter(Boolean)) {
    const m = line.match(/^(\S+) (ok|FAIL)\s+(\S+) \(([\d.]+)s\) (.*)$/);
    if (m) last[m[3]] = { at: m[1], ok: m[2] === "ok", seconds: Number(m[4]), summary: m[5] };
  }
  return last;
}
