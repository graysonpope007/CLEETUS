// src/conversations.mjs — the thread, kept.
//
// WHAT WAS WRONG
// The conversation lived in a JavaScript array in a browser tab. `const
// HISTORY = []` in reach.html, sliced to the last twelve turns and posted with
// every message. So:
//
//   close the tab            the conversation is gone
//   open it on the phone     it is gone there too, and always was
//   thirteen messages in     the beginning of it is gone, silently
//   switch agent             the new agent starts from nothing
//
// Cleetus writes a run file per TASK, which is a record of what he did, not a
// record of what was said — the run files cannot reconstruct a thread and were
// never meant to. So nothing on this machine held the actual conversation, and
// "pick that back up" was not a thing that could be asked.
//
// Now the thread lives here, on disk, and the browser holds an ID. That single
// change is what makes every one of the above work: any device, any agent, any
// day, and the whole thread rather than the last twelve turns.
//
// ONE THREAD, MANY AGENTS
// The agent is recorded PER TURN rather than per conversation. Handing a thread
// to the fitness agent halfway through is a normal thing to do and the thread
// does not restart when it happens — the specialist reads everything said so
// far, and who said it as what. A conversation is a conversation; the agent is
// which of them is answering right now.
//
// JSON, ONE FILE PER THREAD, in ~/cleetus-memory. Not a database, for the same
// reason as everything else here: he can open one, read it, and delete it, and
// it is gone on the next request with no migration.

import { readFile, writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.mjs";
import { slugify } from "./memory.mjs";

import { localStamp } from "./when.mjs";
const DIR = join(CONFIG.memoryRoot, "conversations");

// A thread this long is not a conversation any more, it is a log. The whole
// thing is kept on disk either way — this is only what gets replayed into the
// model, and it is applied from the END so the recent turns always survive.
const REPLAY_TURNS = Number(process.env.CLEETUSD_REPLAY_TURNS || 40);
const REPLAY_CHARS = Number(process.env.CLEETUSD_REPLAY_CHARS || 60_000);

const file = (id) => join(DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, "")}.json`);

async function ensure() {
  await mkdir(DIR, { recursive: true });
}

/** Short and sortable: newest conversations sort last by name, oldest first. */
function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomUUID().slice(0, 4)}`;
}

/**
 * The name Grayson will scan a list of these by.
 *
 * Taken from the first thing he actually said, because that is what he will
 * remember about it. Titles are computed once and then left alone — a title
 * that changes as the conversation goes on is one he cannot find again.
 */
function titleFrom(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "Untitled";
  return t.length > 72 ? t.slice(0, 71).replace(/\s\S*$/, "") + "…" : t;
}

export async function create({ agent = "cleetus", title = "" } = {}) {
  await ensure();
  const now = new Date().toISOString();
  const convo = { id: newId(), agent, title, created: now, updated: now, messages: [] };
  await writeFile(file(convo.id), JSON.stringify(convo, null, 2), "utf8");
  return convo;
}

export async function load(id) {
  if (!id) return null;
  const raw = await readFile(file(id), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!Array.isArray(c.messages)) c.messages = [];
    return c;
  } catch { return null; }
}

/**
 * Load, or make one that exists from here on.
 *
 * An unknown id CREATES rather than 404s, keeping the id the caller already
 * holds. A browser that has an id in localStorage from before the memory root
 * was moved would otherwise be wedged: every message fails, and the only remedy
 * is knowing to clear site data.
 */
export async function open(id, { agent = "cleetus" } = {}) {
  if (id) {
    const found = await load(id);
    if (found) return found;
    await ensure();
    const now = new Date().toISOString();
    const convo = { id: String(id).replace(/[^A-Za-z0-9_-]/g, ""), agent, title: "", created: now, updated: now, messages: [] };
    if (convo.id) {
      await writeFile(file(convo.id), JSON.stringify(convo, null, 2), "utf8");
      return convo;
    }
  }
  return create({ agent });
}

export async function append(id, entries) {
  const convo = await load(id);
  if (!convo) return null;
  const now = new Date().toISOString();
  for (const e of entries) {
    convo.messages.push({ role: e.role, content: e.content, agent: e.agent || null, at: e.at || now });
    if (!convo.title && e.role === "user") convo.title = titleFrom(
      Array.isArray(e.content)
        ? e.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
        : e.content,
    );
  }
  if (entries.some((e) => e.agent)) convo.agent = entries.filter((e) => e.agent).pop().agent;
  convo.updated = now;
  await writeFile(file(convo.id), JSON.stringify(convo, null, 2), "utf8");
  return convo;
}

/**
 * What actually goes to the model.
 *
 * Trimmed from the front, never the back, and by BOTH a turn count and a
 * character budget — one long pasted file in the middle of a thread is enough
 * to blow a window that forty short turns never would.
 *
 * The images are dropped from everything except the last turn. A conversation
 * with six screenshots in it re-sends all six on every message otherwise, and
 * they have already been described into text by describeImages — so the
 * description survives and the megabyte does not.
 */
export function replay(convo) {
  if (!convo?.messages?.length) return [];
  const msgs = convo.messages.slice(-REPLAY_TURNS).map((m, i, arr) => {
    if (!Array.isArray(m.content)) return { role: m.role, content: m.content };
    if (i === arr.length - 1) return { role: m.role, content: m.content };
    const text = m.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    const n = m.content.filter((b) => b?.type === "image").length;
    return { role: m.role, content: `${text}${n ? `\n[${n} image(s) sent earlier in this conversation]` : ""}` };
  });
  let total = 0;
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const size = JSON.stringify(msgs[i].content || "").length;
    if (kept.length && total + size > REPLAY_CHARS) break;
    total += size;
    kept.unshift(msgs[i]);
  }
  return kept;
}

/** Newest first, for the rail on the Reach page. */
export async function list({ agent = null, limit = 40 } = {}) {
  await ensure();
  const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  const rows = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(DIR, f), "utf8"));
      if (agent && c.agent !== agent) continue;
      if (!c.messages?.length) continue;   // opened and abandoned; not a conversation
      rows.push({
        id: c.id,
        title: c.title || "Untitled",
        agent: c.agent || "cleetus",
        // Every agent that has spoken in this thread, so a handed-off
        // conversation is recognisable as one in the list.
        agents: [...new Set(c.messages.map((m) => m.agent).filter(Boolean))],
        turns: c.messages.filter((m) => m.role === "user").length,
        created: c.created,
        updated: c.updated,
      });
    } catch { /* a half-written file is not a reason to lose the list */ }
  }
  return rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, limit);
}

export async function remove(id) {
  await unlink(file(id)).catch(() => {});
  return true;
}

/**
 * Search every past conversation.
 *
 * This is the half that makes context persist ACROSS threads rather than only
 * within one. Facts he stated are already caught by MEMORY.md, but a decision
 * reached over ten messages three weeks ago is not a fact anyone thought to
 * remember — it is a conversation, and until now nothing could go and read it.
 */
export async function search(query, { limit = 5 } = {}) {
  await ensure();
  const words = String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (!words.length) return [];
  const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  const hits = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(DIR, f), "utf8"));
      if (!c.messages?.length) continue;
      const flat = c.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
        .toLowerCase();
      let score = 0;
      for (const w of words) if (flat.includes(w)) score++;
      if (!score) continue;
      // The matching stretch, not the top of the file. A conversation opens
      // with "hey" as often as not, and the first 400 characters of it are
      // rarely the part that matched.
      const at = flat.indexOf(words.find((w) => flat.includes(w)));
      hits.push({
        id: c.id,
        title: c.title || "Untitled",
        agent: c.agent,
        updated: c.updated,
        score,
        excerpt: c.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[image]"}`)
          .join("\n").slice(Math.max(0, at - 200), at + 900),
      });
    } catch {}
  }
  return hits.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated))).slice(0, limit);
}

/** A one-line-per-thread digest of what has been talked about lately. */
export async function recentDigest(limit = 6) {
  const rows = await list({ limit });
  if (!rows.length) return "";
  return rows
    .map((r) => `- ${r.id} · ${r.title} (${r.agent}, ${r.turns} turn${r.turns === 1 ? "" : "s"}, last ${localStamp(r.updated)})`)
    .join("\n");
}

export { titleFrom, slugify };
