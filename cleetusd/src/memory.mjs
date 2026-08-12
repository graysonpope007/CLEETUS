// src/memory.mjs — what Cleetus keeps, as files Grayson can open.
//
// Three kinds, deliberately separate because they decay differently:
//
//   runs/    what he DID. One markdown file per task, written as it happens.
//            Append-only history. This is the Hermes-agent shape: the work
//            leaves a trace you can read, disagree with, and hand back.
//   skills/  how to do it NEXT time. Distilled from a run, retrieved by
//            keyword, injected into later prompts. Procedure, not rules.
//   MEMORY.md  facts about Grayson he said out loud. Durable, small, and read
//            into every single prompt.
//
// WHY MARKDOWN AND NOT A TABLE
// A row in a database that shapes what an assistant does is a thing you cannot
// argue with. Grayson opens this vault daily. If a skill is wrong he deletes
// the file and it is gone on the next request, no deploy and no migration.

import { readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";

const RUNS = join(CONFIG.memoryRoot, CONFIG.runsDir);
const SKILLS = join(CONFIG.memoryRoot, CONFIG.skillsDir);

// MEMORY.md is Grayson's own note and lives in the vault, which a launchd
// daemon cannot open (see config.mjs). Every touch of it is time-boxed, and if
// it is blocked the fact still gets written locally rather than dropped.
const VAULT_MEMORY = join(CONFIG.vault, "MEMORY.md");
const LOCAL_MEMORY = join(CONFIG.memoryRoot, "MEMORY.md");

/**
 * A filesystem call that cannot hang the process.
 *
 * Promise.race does not cancel the loser — the blocked open() is still sat in
 * the kernel holding a libuv threadpool slot. That is survivable (the pool is
 * 4 by default and this only happens on the vault path) and it is strictly
 * better than the alternative, which is the entire daemon stopping.
 */
async function boxed(promise, fallback, label = "fs") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out`)), CONFIG.fsTimeoutMs); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Which MEMORY.md we can actually reach right now. */
async function memoryFile() {
  const reachable = await boxed(
    readFile(VAULT_MEMORY, "utf8").then(() => true),
    false,
    "vault MEMORY.md",
  );
  return reachable ? VAULT_MEMORY : LOCAL_MEMORY;
}

async function ensureDirs() {
  await mkdir(RUNS, { recursive: true });
  await mkdir(SKILLS, { recursive: true });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    file: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`,
    iso: d.toISOString(),
  };
}

export function slugify(s, max = 48) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max) || "task";
}

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * Opens a run file immediately, before the work starts. If the process dies
 * mid-task the file still shows what he was asked and how far he got, which is
 * the whole reason to write it up front rather than at the end.
 */
export async function startRun({ agent, request }) {
  await ensureDirs();
  const t = stamp();
  const path = join(RUNS, `${t.file}-${slugify(request)}.md`);
  const body =
    `---\n` +
    `agent: ${agent}\n` +
    `started: ${t.iso}\n` +
    `status: running\n` +
    `---\n\n` +
    `# ${request.replace(/\n+/g, " ").slice(0, 120)}\n\n` +
    `**Asked** ${t.date} ${t.time}\n\n` +
    `## Steps\n\n`;
  await writeFile(path, body, "utf8");
  return { path, startedAt: Date.now() };
}

/** One line per tool call, as it happens. The audit trail is the run file. */
export async function logStep(run, { tool, args, result, ok = true }) {
  if (!run?.path) return;
  const arg = JSON.stringify(args ?? {});
  const out = String(result ?? "").replace(/\n/g, " ").slice(0, 300);
  await appendFile(
    run.path,
    `- ${ok ? "" : "FAILED "}\`${tool}\` ${arg.slice(0, 200)}\n  ${out}\n`,
    "utf8",
  ).catch(() => {});
}

export async function finishRun(run, { answer, status = "done" }) {
  if (!run?.path) return;
  const secs = Math.round((Date.now() - run.startedAt) / 1000);
  await appendFile(run.path, `\n## Answer\n\n${answer || "(none)"}\n\n_${status} in ${secs}s_\n`, "utf8").catch(() => {});
  try {
    const text = await readFile(run.path, "utf8");
    await writeFile(run.path, text.replace("status: running", `status: ${status}`), "utf8");
  } catch {}
}

// ── Skills (procedural memory) ──────────────────────────────────────────────

/**
 * A skill is a PROCEDURE, not a rule. "Don't open the brief with weather" is a
 * rule and belongs in an agent's notes. "To close the books for a month: pull
 * the ledger, group by business, reconcile against Plaid, then summarise" is a
 * skill, and it is the thing that lets a smaller model do something it could
 * not do cold.
 */
export async function saveSkill({ title, when, steps, agent = "cleetus" }) {
  await ensureDirs();
  const slug = slugify(title);
  const path = join(SKILLS, `${slug}.md`);
  const t = stamp();
  const body =
    `---\n` +
    `skill: ${title}\n` +
    `agent: ${agent}\n` +
    `learned: ${t.iso}\n` +
    `uses: 0\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `**Use when** ${when}\n\n` +
    `## Procedure\n\n` +
    (Array.isArray(steps) ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : String(steps)) +
    `\n`;
  await writeFile(path, body, "utf8");
  return path;
}

export async function loadSkills() {
  await ensureDirs();
  const files = (await readdir(SKILLS).catch(() => [])).filter((f) => f.endsWith(".md"));
  const out = [];
  for (const f of files) {
    try {
      const text = await readFile(join(SKILLS, f), "utf8");
      const title = (text.match(/^skill:\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, "");
      const when = (text.match(/\*\*Use when\*\*\s*(.+)$/m) || [])[1] || "";
      out.push({ file: f, title, when, body: text.split("## Procedure")[1]?.trim() || "" });
    } catch {}
  }
  return out;
}

// Words that carry no topic. Without this, "what" alone matches almost any
// skill whose "use when" line is written as a natural sentence — and the
// teacher writes them exactly that way, so this got worse the moment skills
// started being any good. Observed: "what colour should I paint the shed"
// retrieved a workout-volume skill, because both contain the word "what".
const STOPWORDS = new Set([
  "what", "when", "where", "which", "should", "would", "could", "this", "that",
  "these", "those", "with", "from", "have", "been", "were", "they", "them",
  "your", "yours", "mine", "about", "there", "their", "then", "than", "some",
  "any", "does", "doing", "done", "make", "made", "want", "need", "know",
  "tell", "give", "show", "user", "asks", "question", "using", "into", "just",
  "like", "more", "much", "many", "over", "also", "here", "help", "please",
]);

function contentWords(s) {
  return new Set(
    (String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOPWORDS.has(w)),
  );
}

/**
 * Retrieval, not a dump. Injecting all of them would grow the prompt without
 * bound as they accumulate, and bury the two that matter.
 *
 * Two content words must match, not one. A single shared word is noise at this
 * corpus size — the whole point of retrieval is that an irrelevant skill costs
 * more than a missing one, because a wrong procedure in the prompt is followed.
 * A one-word match still counts when it appears in the TITLE, which is short
 * and deliberately chosen, unlike the prose of a "use when" line.
 */
export async function relevantSkills(question, max = 3) {
  const skills = await loadSkills();
  if (!skills.length) return [];
  const words = contentWords(question);
  if (!words.size) return [];

  return skills
    .map((s) => {
      const title = String(s.title).toLowerCase();
      const when = String(s.when).toLowerCase();
      let score = 0, titleHits = 0;
      for (const w of words) {
        if (title.includes(w)) { score += 2; titleHits++; }
        else if (when.includes(w)) score += 1;
      }
      return { ...s, score, titleHits };
    })
    .filter((s) => s.score >= 2 || s.titleHits >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** Newest runs first, for the dashboard's "recent work" column. */
export async function recentRuns(limit = 12) {
  await ensureDirs();
  const files = (await readdir(RUNS).catch(() => [])).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, limit);
  const out = [];
  for (const f of files) {
    try {
      const text = await readFile(join(RUNS, f), "utf8");
      out.push({
        file: f,
        agent: (text.match(/^agent:\s*(.+)$/m) || [])[1] || "cleetus",
        status: (text.match(/^status:\s*(.+)$/m) || [])[1] || "done",
        title: (text.match(/^# (.+)$/m) || [])[1] || f.replace(/\.md$/, ""),
      });
    } catch {}
  }
  return out;
}

// ── Durable facts ───────────────────────────────────────────────────────────

// MEMORY.md is Grayson's, not Cleetus's. It is a hand-maintained file with real
// structure — roster, relationships, decisions — and it happens to END on
// "## Pending — Needs Grayson's Input". Appending to the file therefore files
// every new fact under Pending, where a thing Cleetus KNOWS reads as a thing he
// is WAITING ON. So writes go into a section of his own, created on first use
// and inserted ahead of any trailing section rather than at EOF.
const LEARNED_HEADING = "## Learned by Cleetus";

export async function remember(fact, { source = "chat" } = {}) {
  const t = stamp();
  const line = `- ${fact.trim().replace(/\n+/g, " ")} _(${t.date}, ${source})_`;
  const MEMORY_FILE = await memoryFile();

  const text = await boxed(readFile(MEMORY_FILE, "utf8"), null, "read MEMORY.md");
  if (text === null) {
    await mkdir(CONFIG.memoryRoot, { recursive: true });
    await writeFile(MEMORY_FILE, `# Memory\n\n${LEARNED_HEADING}\n\n${line}\n`, "utf8");
    return MEMORY_FILE;
  }

  if (!text.includes(LEARNED_HEADING)) {
    // First write. Land the section before the last top-level heading so it
    // does not bury whatever he keeps at the bottom on purpose.
    const lines = text.split("\n");
    let at = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^## /.test(lines[i])) { at = i; break; }
    }
    lines.splice(at, 0, LEARNED_HEADING, "", line, "");
    await writeFile(MEMORY_FILE, lines.join("\n"), "utf8");
    return MEMORY_FILE;
  }

  // Append under the existing section: after its heading, before the next one.
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === LEARNED_HEADING);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, line);
  await writeFile(MEMORY_FILE, lines.join("\n"), "utf8");
  return MEMORY_FILE;
}

/**
 * The whole file, not a tail slice. The previous version took the last 60
 * bullet lines, which is an arbitrary cut through his roster and relationships
 * that drops the top of the file — the imminent-this-week section — first.
 * It is ~150 lines. Injecting all of it costs less than injecting the wrong
 * half of it.
 */
// ── Per-agent memory ────────────────────────────────────────────────────────
//
// Shared memory alone is not enough and neither is per-agent memory alone.
// What he tells the skin agent about a reaction should be the skin agent's to
// remember in detail; what he tells Cleetus about his week should reach every
// specialist; and Cleetus should know what he told the specialists, because
// otherwise the generalist is the least informed thing in the system.
//
// So both, with a direction:
//
//   MEMORY.md          everyone reads it, everyone can write it
//   agents/<id>.md     that specialist reads its own in full
//   the generalist     reads shared, plus a HEADLINE of each specialist file
//
// The asymmetry is the point. A specialist gets depth in its own subject and
// nothing of anyone else's, which is what makes it specialised. The generalist
// gets breadth without drowning — it learns THAT the skin agent knows about a
// benzoyl peroxide reaction, and can go and read the file when it matters.
const AGENT_MEM = join(CONFIG.memoryRoot, "agents");

function agentMemFile(id) {
  return join(AGENT_MEM, `${String(id).toLowerCase().replace(/[^a-z0-9-]/g, "")}.md`);
}

/** Something learned while a specialist was the one talking. */
export async function rememberForAgent(agentId, fact) {
  if (!agentId || agentId === "cleetus") return remember(fact, { source: "chat" });
  await mkdir(AGENT_MEM, { recursive: true });
  const path = agentMemFile(agentId);
  const t = stamp();
  const line = `- ${String(fact).trim().replace(/\n+/g, " ")} _(${t.date})_\n`;
  if (!existsSync(path)) {
    await writeFile(
      path,
      `# ${agentId} — what this agent has learned\n\n` +
      `Read in full by the ${agentId} agent on every message, and as a headline by\n` +
      `the generalist. Delete a line and it is gone on the next request.\n\n${line}`,
      "utf8",
    );
  } else {
    await appendFile(path, line, "utf8");
  }
  return path;
}

/** Everything one specialist knows, in full. */
export async function loadAgentMemory(agentId, maxChars = 6_000) {
  if (!agentId || agentId === "cleetus") return "";
  const text = await boxed(readFile(agentMemFile(agentId), "utf8"), "", "agent memory");
  const body = String(text).split("\n").filter((l) => l.startsWith("- ")).join("\n");
  return body.length > maxChars ? body.slice(-maxChars) : body;
}

/**
 * What every specialist knows, in outline, for the generalist.
 *
 * Capped hard per agent. The generalist reading all of it in full would be a
 * prompt that grows without bound and a specialist that is not special.
 */
export async function loadAllAgentMemory(perAgent = 4) {
  const files = await boxed(readdir(AGENT_MEM), [], "agent memory dir");
  const out = [];
  for (const f of (files || []).filter((x) => x.endsWith(".md"))) {
    const text = await boxed(readFile(join(AGENT_MEM, f), "utf8"), "", "agent memory");
    const lines = String(text).split("\n").filter((l) => l.startsWith("- "));
    if (!lines.length) continue;
    const id = f.replace(/\.md$/, "");
    const shown = lines.slice(-perAgent);
    out.push(
      `**${id}**${lines.length > perAgent ? ` (${lines.length} total, latest ${perAgent})` : ""}\n` +
      shown.join("\n"),
    );
  }
  return out.join("\n\n");
}

export async function loadMemory(maxChars = 12_000) {
  try {
    const raw = await boxed(readFile(await memoryFile(), "utf8"), "", "load MEMORY.md");
    const text = String(raw).trim();
    if (!text) return "";
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n\n[MEMORY.md truncated — read it in full with vault_read MEMORY.md]";
  } catch {
    return "";
  }
}
