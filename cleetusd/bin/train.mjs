#!/usr/bin/env node
// bin/train.mjs — write each agent a real standing brief.
//
//   node bin/train.mjs --dry            show what it would write, change nothing
//   node bin/train.mjs skin hair        train just those
//   node bin/train.mjs                  train every agent that has a file
//
// The briefs shipped at roughly 750 characters each: enough to name a subject,
// not enough to make an agent good at it. This asks Claude Opus 5 to write the
// standing instructions a specialist actually needs, grounded in what is
// already known about Grayson rather than in general advice about the subject.
//
// WHAT IT IS AND IS NOT
// This is not fine-tuning and it does not touch weights. It writes the prompt
// that laguna reads on every message as that agent. The whole system is built
// on the same idea as skills: a smaller model given the right procedure beats
// a bigger one given none.
//
// Grounding matters more than length. A brief that could have been written
// about anyone is the failure — the same failure the dossiers exist to
// prevent — so the model is given his real context and told that generic
// output is a rejected result.
//
// Every original is backed up next to it as <agent>.md.bak.<stamp>. Nothing
// here is destructive and nothing is applied without --write being implied by
// the absence of --dry.

import { readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG, secrets } from "../src/config.mjs";
import { AGENTS } from "../src/agents.mjs";

const DRY = process.argv.includes("--dry");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MODEL = process.env.CLEETUSD_TEACHER_MODEL || "claude-opus-5";

if (!secrets.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set in cleetus.env — nothing to train with.");
  process.exit(1);
}
const client = new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });

// ── What the trainer knows about him ────────────────────────────────────────
// Read from the vault so the briefs are about Grayson rather than about the
// subject in the abstract. Missing files are fine and are said so — an absent
// fact must never be filled in by the trainer.
async function context() {
  const want = ["CRITICAL_FACTS.md", "USER.md", "SOUL.md", "40-Areas/Health/body.md", "40-Areas/Health/health.md"];
  const parts = [];
  for (const f of want) {
    const t = await readFile(join(CONFIG.vault, f), "utf8").catch(() => "");
    if (t.trim()) parts.push(`--- ${f} ---\n${t.slice(0, 6000)}`);
  }
  const brain = await readFile(join(CONFIG.home, "cleetusv2/brain/cleetus-brain.md"), "utf8").catch(() => "");
  if (brain.trim()) parts.push(`--- shared identity (cleetus-brain.md) ---\n${brain.slice(0, 6000)}`);
  return parts.join("\n\n") || "(nothing on file yet)";
}

const TOOLS = [
  "read_file, write_file, edit_file — any file on his Mac",
  "list_dir, search_files, find_files — ripgrep across the disk",
  "run_shell — zsh on his machine",
  "vault_search, vault_read — his Obsidian brain",
  "remember_fact — durable memory, scope 'shared' or 'mine'",
  "save_skill — write down a repeatable procedure",
  "cloud_api — the deployed app: Plaid, Schwab, Google Calendar, /api/fitness/*, /api/nutrition/*, /api/outfit, /api/ledger/pnl",
  "browse — a real browser; reads execute, purchases queue for his approval",
  "check_access — what of the disk is reachable right now",
].join("\n");

const SYSTEM = [
  "You write standing briefs for the specialist agents of a personal assistant called Cleetus.",
  "",
  "A brief is pasted into that agent's system prompt on EVERY message, on top of a shared identity file. It is not documentation and nobody reads it for pleasure. It is the instructions that make this agent good at its subject and unmistakably about Grayson.",
  "",
  "The model reading it is laguna-xs-2.1, a 33B running locally. Write for that: concrete, ordered, decidable. It follows instructions literally, so an escape clause will be used and a vague preference will be ignored.",
  "",
  "WHAT MAKES A GOOD BRIEF",
  "- The judgement calls that separate a specialist from a search engine. What to lead with. What to check before answering. What order to change things in. What tradeoff to make when two goals conflict.",
  "- Grounding in HIS situation, using the context you are given. If a brief would read the same for a stranger, it has failed.",
  "- Where the real data lives, by exact endpoint or file, and the standing instruction never to guess a number he could look up.",
  "- The specific ways this subject goes wrong, and what to do instead.",
  "- What this agent must NOT do, where that is a real risk rather than a platitude.",
  "",
  "HARD RULES",
  "- Never invent a fact about him. If the context does not say, the brief says to ask.",
  "- No medical, legal or financial diagnosis. Say plainly when something is a doctor's call.",
  "- Plain text in his replies: no markdown headers, no bold, no numbered lists, no bullet symbols, no em dashes. Advice is written as sentences. Exceptions are documents meant to be formatted and technical work where structure IS the content.",
  "- Do not pad. 250 words that change what the agent does beats 900 that restate the subject.",
  "",
  "FORMAT: markdown, and keep the shape the existing brief uses — a one-line statement of the job, then '## How to answer', '## Never', '## Notes'. Add a section only if it earns its place.",
  "",
  "Return ONLY the markdown of the new brief. No preamble, no explanation, no code fence.",
].join("\n");

async function train(id, existing, ctx) {
  const agent = AGENTS[id];
  const msg = [
    `Agent id: ${id}`,
    `Role: ${agent?.label || id} — ${agent?.blurb || ""}`,
    agent?.needs?.length ? `Context this agent is given automatically every message: ${agent.needs.join(", ")}` : "",
    ``,
    `Tools it can call:`,
    TOOLS,
    ``,
    `What is known about Grayson:`,
    ctx,
    ``,
    `Its current brief, which is too thin:`,
    existing || "(none)",
    ``,
    `Write the replacement.`,
  ].filter(Boolean).join("\n");

  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: msg }],
  });

  if (res.stop_reason === "refusal") throw new Error(`declined (${res.stop_details?.category ?? "no category"})`);
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// ── run ─────────────────────────────────────────────────────────────────────
const files = (await readdir(CONFIG.agentBriefs)).filter((f) => f.endsWith(".md") && f !== "_template.md");
const ids = (only.length ? only : files.map((f) => f.replace(/\.md$/, "")));
const ctx = await context();
const stamp = Date.now();

console.error(`training ${ids.length} agent(s) with ${MODEL}${DRY ? " (dry run)" : ""}\n`);

for (const id of ids) {
  const path = join(CONFIG.agentBriefs, `${id}.md`);
  const existing = await readFile(path, "utf8").catch(() => "");
  process.stderr.write(`  ${id.padEnd(12)} ${String(existing.length).padStart(5)} chars -> `);
  try {
    const brief = await train(id, existing, ctx);
    if (!brief || brief.length < 200) throw new Error(`suspiciously short (${brief.length})`);
    if (DRY) {
      console.error(`${String(brief.length).padStart(5)} chars (not written)`);
      if (ids.length === 1) console.log("\n" + brief);
    } else {
      if (existing) await copyFile(path, `${path}.bak.${stamp}`);
      await writeFile(path, brief.endsWith("\n") ? brief : brief + "\n", "utf8");
      console.error(`${String(brief.length).padStart(5)} chars written`);
    }
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
  }
}

console.error(DRY ? "\ndry run — nothing written" : `\ndone. originals kept as *.md.bak.${stamp}`);
