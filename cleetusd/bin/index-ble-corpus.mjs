#!/usr/bin/env node
// index-ble-corpus.mjs — build vendor/ble/index.json from the fetched corpus.
//
// Walks vendor/ble/<repo>/ for markdown (README, SKILL.md, docs, notes) and
// records one index entry per document: a stable name, a human title, a short
// description (frontmatter `description`, else the first real paragraph), the
// source repo, and the path relative to vendor/ble. bleskills.mjs reads this.
//
// Deliberately dependency-free and read-only over the corpus: it only reads .md
// and writes the one index.json. Re-run any time after fetching more.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ble");
if (!existsSync(LIB)) { console.error(`no corpus at ${LIB}; run bin/fetch-ble-corpus.sh first`); process.exit(1); }

const SKIP_DIRS = new Set([".git", "node_modules", ".github", "images", "img", "assets", ".venv", "dist", "build"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (/\.(md|mdx|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const meta = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

function firstParagraph(text) {
  const body = text.replace(/^---[\s\S]*?\n---\s*/, "");
  const lines = body.split("\n");
  const buf = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { if (buf.length) break; else continue; }
    if (/^(#{1,6}\s|!\[|<|\[!|=+$|-+$|\|)/.test(l)) { if (buf.length) break; else continue; }
    buf.push(l.replace(/[*_`>]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
    if (buf.join(" ").length > 240) break;
  }
  return buf.join(" ").slice(0, 300);
}

function title(text, path) {
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].replace(/[*_`#]/g, "").trim().slice(0, 120);
  return path.split("/").slice(-2).join("/");
}

function slug(repo, rel) {
  const base = rel.replace(/\.(md|mdx|markdown)$/i, "").replace(/\/README$/i, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return base ? `${repo}--${base}` : repo;
}

// Repos that are ENTIRELY about Bluetooth: every doc is in scope. Anything else
// (Claude-Red is a general red-team skill set, only its wireless/bluetooth skill
// belongs here) is filtered to Bluetooth-relevant docs so a BLE search does not
// surface Kubernetes and GraphQL skills.
const DEDICATED = new Set([
  "bluetooth-mcp-server", "awesome-ble", "awesome-bluetooth-security",
  "awesome-web-bluetooth", "nRF52-Bluetooth-Course", "bt-re-mad-skillz",
  // The Bluetooth-Devices org libs and bleak are entirely Bluetooth: index every doc.
  "bleak", "bleak-retry-connector", "bluetooth-data-tools",
  "bluetooth-adapters", "bluetooth-auto-recovery",
]);
// Repos that are NOT Bluetooth-dedicated but are cloned here for a few Bluetooth
// docs: keep only the docs whose PATH names Bluetooth, so the general contents
// (e.g. the Anthropic repo's 800+ non-Bluetooth skills, already served by
// find_security_skill) do not leak into a BLE search.
const STRICT_BT = new Set(["Anthropic-Cybersecurity-Skills"]);
const STRICT_BT_PATH = /bluetooth|\bble\b/i;
const BT_PATH = /bluetooth|\bble\b|wireless|gatt|\bhci\b|l2cap|rfcomm/i;
const BT_TEXT = /bluetooth|\bble\b|gatt|gatttool|\bhci\b|l2cap|advertis|nrf|bleak|smp pairing/i;
function relevant(repo, rel, text) {
  if (DEDICATED.has(repo)) return true;
  if (STRICT_BT.has(repo)) return STRICT_BT_PATH.test(rel);
  if (BT_PATH.test(rel)) return true;
  return BT_TEXT.test(text.slice(0, 4000));
}

const repos = readdirSync(LIB, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name);
const docs = [];
for (const repo of repos) {
  for (const file of walk(join(LIB, repo))) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (!text.trim()) continue;
    const rel = relative(LIB, file);
    if (!relevant(repo, rel, text)) continue;
    const fm = frontmatter(text);
    docs.push({
      name: fm.name ? `${repo}--${String(fm.name).toLowerCase()}` : slug(repo, relative(join(LIB, repo), file)),
      title: fm.title || fm.name || title(text, rel),
      description: (fm.description || firstParagraph(text) || "").slice(0, 300),
      repo,
      path: rel,
      bytes: statSync(file).size,
    });
  }
}
docs.sort((a, b) => a.name.localeCompare(b.name));
const index = { version: "1.0.0", generated_at: new Date().toISOString(), domain: "bluetooth", total_docs: docs.length, repos: repos.sort(), docs };
writeFileSync(join(LIB, "index.json"), JSON.stringify(index, null, 0) + "\n");
console.log(`indexed ${docs.length} documents across ${repos.length} repos -> vendor/ble/index.json`);
for (const r of repos.sort()) console.log(`  ${docs.filter((d) => d.repo === r).length.toString().padStart(4)}  ${r}`);
