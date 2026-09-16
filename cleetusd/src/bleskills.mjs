// src/bleskills.mjs — the Bluetooth / BLE knowledge corpus, searched and loaded
// on demand, exactly like the cybersecurity library next door (secskills.mjs).
//
// Grayson pulled together a shelf of Bluetooth material on 2026-09-15: the
// awesome-* indexes (web-bluetooth, ble, bluetooth-security), a research skill
// set (darkmentorllc/bt-re-mad-skillz), the Nordic nRF52 course, the offensive
// BLE SKILL.md files from Anthropic-Cybersecurity-Skills and Claude-Red, and a
// reference MCP server. It is far too much to inject, and a menu of a few
// hundred one-liners would be prompt weight paid on every turn for nothing. So
// it works like a bookshelf: a compact index is known, a search narrows it, and
// exactly one document is opened when it is actually needed.
//
// The corpus lives under vendor/ble/, one subdirectory per source repo, and is
// indexed into vendor/ble/index.json by bin/index-ble-corpus.mjs. The repos are
// fetched by bin/fetch-ble-corpus.sh (run by Grayson — the harness blocks the
// daemon from pulling external code itself, correctly).
//
// Read-only by contract. Nothing here clones, writes, or executes; it reads
// markdown under vendor/ble/ and returns text. The material is offensive and
// defensive both, which is what a Bluetooth security shelf is. The agent's brief
// is where the "authorized use, his own devices and lab" judgement lives.

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LIB = join(ROOT, "vendor", "ble");
const INDEX_PATH = join(LIB, "index.json");

export function libraryPresent() {
  return existsSync(INDEX_PATH);
}

// ── The index, loaded once ───────────────────────────────────────────────────
let _index = null;

/** [{name, title, description, repo, path}], from vendor/ble/index.json. */
export function docIndex() {
  if (_index) return _index;
  if (!libraryPresent()) return (_index = []);
  try {
    _index = JSON.parse(readFileSync(INDEX_PATH, "utf8")).docs || [];
  } catch {
    _index = [];
  }
  return _index;
}

const STOP = new Set(("a an the of for to and or with in on at by from is are be use " +
  "using how do i my this that what when your you bluetooth ble").split(" "));

function words(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9][a-z0-9.-]{1,}/g) || [];
}

/**
 * Score the index against a query and return the best matches.
 *
 * Weighted like secskills: a hit in the short name/title beats one in the long
 * description, and full coverage of a multi-word query is rewarded. A protocol
 * term or tool name (gatttool, bleak, hci, l2cap, KNOB, BLESA) in the query
 * matches verbatim, which is usually the strongest possible signal.
 */
export function searchDocs(query, limit = 8) {
  const idx = docIndex();
  if (!idx.length) return [];
  const qWords = [...new Set(words(query))].filter((w) => !STOP.has(w));
  if (!qWords.length) return [];

  const scored = idx.map((d) => {
    const name = (d.name || "").toLowerCase();
    const title = (d.title || "").toLowerCase();
    const hay = `${name} ${title}`;
    const hayWords = new Set(hay.split(/[^a-z0-9]+/));
    const desc = (d.description || "").toLowerCase();
    let score = 0;
    for (const w of qWords) {
      if (hayWords.has(w)) score += 5;
      else if (hay.includes(w)) score += 3;
      if (desc.includes(w)) score += 1;
    }
    const covered = qWords.filter((w) => hay.includes(w) || desc.includes(w)).length;
    if (covered === qWords.length && qWords.length > 1) score += 2;
    return { ...d, score };
  });

  return scored
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** One document's full text + parsed title, by exact name or path. */
export async function loadDoc(nameOrPath) {
  const idx = docIndex();
  const want = String(nameOrPath || "").trim().toLowerCase();
  const entry = idx.find(
    (d) => (d.name || "").toLowerCase() === want || (d.path || "").toLowerCase() === want
  );
  if (!entry) {
    const near = searchDocs(want.replace(/[-/]/g, " "), 5);
    return { ok: false, error: `No Bluetooth doc named "${want}".`, suggestions: near.map((d) => d.name) };
  }
  const file = join(LIB, entry.path);
  if (!existsSync(file)) {
    return { ok: false, error: `Indexed but missing on disk: ${entry.path}. Re-run bin/fetch-ble-corpus.sh.` };
  }
  const MAX = 60_000;   // a long awesome-list can be huge; hand back a readable slice
  let text = await readFile(file, "utf8");
  let truncated = false;
  if (text.length > MAX) { text = text.slice(0, MAX); truncated = true; }
  return { ok: true, name: entry.name, title: entry.title, repo: entry.repo, path: entry.path, body: text, truncated };
}

/** Counts for the prompt line, and the repo roster. */
export function libraryStats() {
  const idx = docIndex();
  const repos = new Set();
  for (const d of idx) if (d.repo) repos.add(d.repo);
  return { present: libraryPresent(), docs: idx.length, repos: [...repos].sort() };
}
