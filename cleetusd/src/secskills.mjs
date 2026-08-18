// src/secskills.mjs — the 817-skill cybersecurity library, searched and loaded
// on demand rather than poured into every prompt.
//
// mukul975/Anthropic-Cybersecurity-Skills is 8 MB of SKILL.md across 29 domains,
// each mapped to MITRE ATT&CK, NIST CSF, ATLAS, D3FEND and MITRE F3. That is far
// too much to inject, and injecting a menu of 817 one-liners would be 100 KB of
// prompt the model reads on every turn for nothing. So the library works the way
// a person uses a bookshelf: a compact index is known, a search narrows it, and
// exactly one book is opened when it is actually needed.
//
// The security agent's brief points here. It is deliberately NOT on the generalist
// or any other agent — a skin question has no business loading a lateral-movement
// playbook, and 817 red-team titles in the router's menu would only add noise.
//
// Read-only by contract. Nothing here writes, clones, or executes; it reads files
// under vendor/ and returns text. The skills themselves describe offensive and
// defensive techniques both, which is what a security library is — the agent's
// brief is where the "authorized only, fix don't just report" judgement lives.

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LIB = join(ROOT, "vendor", "cybersecurity-skills");
const INDEX_PATH = join(LIB, "index.json");

export function libraryPresent() {
  return existsSync(INDEX_PATH);
}

// ── Frontmatter, without a YAML dependency ───────────────────────────────────
// The frontmatter here is a strict subset — flat scalars and simple `- ` lists,
// no nesting — so a 30-line parser reads it exactly and adds no dependency to a
// daemon whose whole point is to be self-contained. A real YAML lib would parse
// more than this file will ever contain, and be one more thing to keep current.
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text };
  const raw = text.slice(3, end).replace(/^\n/, "");
  const body = text.slice(end + 4).replace(/^\n/, "");

  const meta = {};
  let key = null;
  for (const line of raw.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && key) {
      (meta[key] = Array.isArray(meta[key]) ? meta[key] : []).push(strip(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const val = kv[2].trim();
      // A key with no inline value opens a list on the following lines.
      meta[key] = val === "" ? [] : strip(val);
    }
  }
  return { meta, body };
}

function strip(s) {
  const t = String(s).trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// ── The index, loaded once ───────────────────────────────────────────────────
let _index = null;

/** [{name, description, domain, path}], from the repo's own index.json. */
export function skillIndex() {
  if (_index) return _index;
  if (!libraryPresent()) return (_index = []);
  try {
    _index = JSON.parse(readFileSync(INDEX_PATH, "utf8")).skills || [];
  } catch {
    _index = [];
  }
  return _index;
}

const STOP = new Set(("a an the of for to and or with in on at by from is are be use " +
  "using how do i my this that what when your you security cyber").split(" "));

function words(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9][a-z0-9.-]{1,}/g) || [];
}

/**
 * Score the index against a query and return the best matches.
 *
 * Weighted so a hit in the short, curated name beats a hit in the long
 * description — a title match is almost always the right skill, a description
 * match is often incidental. An ATT&CK id or a tool name (mimikatz, T1003) in
 * the query is a strong signal and matches the name or description verbatim.
 */
export function searchSkills(query, limit = 8) {
  const idx = skillIndex();
  if (!idx.length) return [];
  const qWords = [...new Set(words(query))].filter((w) => !STOP.has(w));
  if (!qWords.length) return [];

  const scored = idx.map((s) => {
    const name = s.name.toLowerCase();
    const nameWords = new Set(name.split(/[^a-z0-9]+/));
    const desc = s.description.toLowerCase();
    let score = 0;
    for (const w of qWords) {
      if (nameWords.has(w)) score += 5;        // whole word in the slug
      else if (name.includes(w)) score += 3;   // substring in the slug
      if (desc.includes(w)) score += 1;
    }
    // A multi-word query that lands several words in one title is very likely
    // the intended skill; reward coverage, not just raw hits.
    const covered = qWords.filter((w) => name.includes(w) || desc.includes(w)).length;
    if (covered === qWords.length && qWords.length > 1) score += 2;
    return { ...s, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** One skill's full text + parsed frontmatter, by exact name or path. */
export async function loadSkill(nameOrPath) {
  const idx = skillIndex();
  const want = String(nameOrPath || "").trim().toLowerCase().replace(/^skills\//, "");
  const entry = idx.find(
    (s) => s.name.toLowerCase() === want || s.path.toLowerCase() === `skills/${want}`
  );
  const rel = entry ? entry.path : `skills/${want}`;
  const file = join(LIB, rel, "SKILL.md");
  if (!existsSync(file)) {
    // Not found by exact name — offer the nearest matches so the model can pick
    // rather than guess again. A wrong-name miss should cost one retry, not a
    // dead end.
    const near = searchSkills(want.replace(/-/g, " "), 5);
    return {
      ok: false,
      error: `No skill named "${want}".`,
      suggestions: near.map((s) => s.name),
    };
  }
  const text = await readFile(file, "utf8");
  const { meta, body } = parseFrontmatter(text);
  return { ok: true, name: entry?.name || want, path: rel, meta, body };
}

/** Counts for the prompt line — proof the library is really here, and how big. */
export function libraryStats() {
  const idx = skillIndex();
  const domains = new Set();
  for (const s of idx) if (s.domain) domains.add(s.domain);
  return { present: libraryPresent(), skills: idx.length };
}
