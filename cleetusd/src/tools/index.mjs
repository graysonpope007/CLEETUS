// src/tools/index.mjs — everything Cleetus can actually do, in one registry.
//
// Three sources, deliberately not merged into one giant new codebase:
//   files.mjs        the Mac: disk and shell.
//   this file        the vault, his own memory, and bridges outward.
//   the bridges      cleetus-web (browser, already has its own safety contract)
//                    and cleetusai.com (Plaid, Schwab, Google, the ledger).
//
// The bridges matter. Plaid tokens and the Schwab OAuth dance live in the
// deployed app and work. Reimplementing them here to feel self-contained would
// mean two things to keep in step and two things to break.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "../config.mjs";
import { fileTools } from "./files.mjs";
import { remember, saveSkill, rememberForAgent } from "../memory.mjs";
import { accessReport } from "../access.mjs";
import { deviceTools } from "./devices.mjs";
import { webTools } from "./web.mjs";
import { mailTools } from "./mail.mjs";
import { visionTools } from "./vision.mjs";
import { faceTools } from "./faces.mjs";
import { trackTools } from "./tracking.mjs";
import { repoTools } from "./repos.mjs";
import { keyringTools } from "./keyring.mjs";
import { recallTools } from "./recall.mjs";
import { workTools } from "./work.mjs";

// ── The vault ───────────────────────────────────────────────────────────────

// The vault is on iCloud. Under launchd, opening a path there does not fail —
// it blocks in the kernel, uncancellably (see config.mjs). Every vault read is
// therefore time-boxed, and a block is reported to the model as a fact it can
// act on rather than a silence it waits inside.
const VAULT_BLOCKED =
  "The Obsidian vault is not readable from here. This happens when cleetusd runs as a launchd " +
  "service, because iCloud will not serve a daemon. Say so plainly rather than guessing at what " +
  "the notes contain, and mention that `~/cleetus-memory` is readable either way.";

async function boxed(promise, fallback, ms = CONFIG.fsTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function walkVault(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  const entries = await boxed(readdir(dir, { withFileTypes: true }), null);
  if (entries === null) return null; // blocked, not empty — a real distinction
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walkVault(p, out, depth + 1);
      if (sub === null) return null;
    } else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Cheap probe used by /health and by the tools before they commit to a walk. */
export async function vaultReachable() {
  return (await boxed(readdir(CONFIG.vault), null, 1500)) !== null;
}

const vaultTools = {
  vault_search: {
    schema: {
      description: "Search Grayson's Obsidian brain (notes on people, venues, projects, health, habits). Use this BEFORE answering anything about his life, work or history.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    async run({ query }) {
      const files = await walkVault(CONFIG.vault);
      if (files === null) return VAULT_BLOCKED;
      const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const hits = [];
      for (const f of files) {
        const text = await boxed(readFile(f, "utf8"), "");
        const low = text.toLowerCase();
        let score = 0;
        for (const w of words) if (low.includes(w)) score++;
        if (score) hits.push({ f, score, text });
      }
      if (!hits.length) return `Nothing in the vault about "${query}".`;
      return hits
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((h) => `## ${h.f.replace(CONFIG.vault + "/", "")}\n${h.text.slice(0, 1500)}`)
        .join("\n\n---\n\n");
    },
  },

  vault_read: {
    schema: {
      description: "Read one note from the Obsidian brain by its path relative to the vault, e.g. USER.md or 40-Areas/Health/skin.md",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    },
    async run({ note }) {
      const p = join(CONFIG.vault, String(note).replace(/^\/+/, ""));
      const text = await boxed(readFile(p, "utf8"), null);
      if (text === null) return (await vaultReachable()) ? `No note at ${note}` : VAULT_BLOCKED;
      return text.slice(0, 40_000);
    },
  },

  remember_fact: {
    schema: {
      description:
        "Save something Grayson said that is worth keeping permanently — a decision, a preference, a fact about his life, body or work. Use it the moment he tells you something new about himself. Choose the scope honestly: 'shared' if every agent should know it, 'mine' if it only matters to your speciality.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "One sentence, written so it still makes sense in six months." },
          scope: {
            type: "string",
            enum: ["shared", "mine"],
            description: "shared = every agent sees it (his schedule, a decision, a life fact). mine = only your speciality needs it (a product that irritated his skin, a lift that aggravates a shoulder). When unsure, shared.",
          },
        },
        required: ["fact"],
      },
    },
    async run({ fact, scope }, ctx) {
      // Scope decides the file. A specialist's detail buried in shared memory
      // is noise in every other agent's prompt; a life fact locked inside one
      // specialist is invisible to the rest, which is the failure this whole
      // split exists to prevent.
      if (scope === "mine" && ctx?.agentId && ctx.agentId !== "cleetus") {
        const p = await rememberForAgent(ctx.agentId, fact);
        return `Saved to your own memory as the ${ctx.agentId} agent (${p}). Other agents will not see this; the generalist sees it as a headline.`;
      }
      await remember(fact);
      return `Saved to shared memory, which every agent reads: ${fact}`;
    },
  },

  save_skill: {
    schema: {
      description: "Write down HOW to do something you just worked out, so it is repeatable next time. Procedure only, not a rule or a preference.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          when: { type: "string", description: "The situation this applies to." },
          steps: { type: "array", items: { type: "string" }, description: "Ordered steps." },
        },
        required: ["title", "when", "steps"],
      },
    },
    async run({ title, when, steps }) {
      const p = await saveSkill({ title, when, steps });
      return `Skill saved: ${p}`;
    },
  },
};

// What this process can actually reach. Given to the model so that when a
// directory looks empty it can tell "nothing there" from "not allowed to
// look", which are the same result from readdir and opposite answers to give.
const accessTools = {
  check_access: {
    schema: {
      description: "Check which parts of Grayson's Mac you can actually read right now — home, Desktop, Documents, the vault, Mail, Messages, Safari, Photos, volumes. Call this BEFORE answering ANY question about what you can or cannot see or reach on his machine, and whenever a folder looks unexpectedly empty or a read fails. Asked 'can you read my texts', the answer is whatever this returns, not what you assume from your tool list — permissions change and your tool list does not.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const r = await accessReport();
      const lines = Object.entries(r.targets).map(([k, v]) => `${k}: ${v.state}${v.detail ? " (" + v.detail + ")" : ""}`);
      // fix is a structured object now. Rendered from fix_text rather than
      // interpolated directly — String(object) is "[object Object]", and the
      // model does not report an empty tool result, it fills the gap with
      // something plausible, which here would be invented remediation advice.
      return (r.full_access ? "Full access to everything probed.\n" : "NOT full access.\n") +
        lines.join("\n") +
        (r.fix_text ? `\n\nFix: ${r.fix_text}` : "") +
        (r.needs_full_disk_access?.length
          ? `\n\nSay this plainly rather than hedging: ${r.needs_full_disk_access.join(", ")} are not ` +
            `empty and are not broken, they are refused by macOS until he ticks Full Disk Access for ` +
            `${r.running_as}. It is one switch and it takes him ten seconds.`
          : "");
    },
  },
};

// ── Bridges ─────────────────────────────────────────────────────────────────

// One session, reused. Logging in per tool call would burn the password
// endpoint's own rate limiter within a single conversation.
let cloudCookie = null;
async function cloudLogin() {
  if (cloudCookie) return cloudCookie;
  if (!CONFIG.sitePassword) throw new Error("SITE_PASSWORD not set; cannot reach the cloud app");
  const r = await fetch(`${CONFIG.cloud}/api/session/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: CONFIG.cloud },
    body: JSON.stringify({ password: CONFIG.sitePassword }),
  });
  const setCookie = r.headers.getSetCookie?.() || [];
  const sess = setCookie.map((c) => c.split(";")[0]).filter((c) => c.startsWith("cleetus_session="));
  if (!sess.length) throw new Error("cloud login failed");
  cloudCookie = sess.join("; ");
  return cloudCookie;
}

const bridgeTools = {
  cloud_api: {
    schema: {
      description:
        "Call the deployed Cleetus API for data that lives in the cloud: money (/api/plaid/accounts, /api/schwab/balances, /api/ledger/pnl), calendar (/api/google/calendar), training (/api/fitness/history, /api/fitness/workout), food (/api/nutrition/diary, /api/nutrition/targets), weather+outfit (/api/outfit), health of the stack (/api/health), tasks (/api/tasks). GET unless you know it takes a POST.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path starting with /api/" },
          method: { type: "string", description: "GET or POST. Defaults to GET." },
          body: { type: "string", description: "JSON string for POST." },
        },
        required: ["path"],
      },
    },
    async run({ path, method = "GET", body }) {
      const cookie = await cloudLogin();
      const r = await fetch(`${CONFIG.cloud}${path.startsWith("/") ? path : "/" + path}`, {
        method: method.toUpperCase(),
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: CONFIG.cloud },
        body: method.toUpperCase() === "POST" ? (body || "{}") : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      return (await r.text()).slice(0, 30_000);
    },
  },

};

// ── Registry ────────────────────────────────────────────────────────────────

export const TOOLS = { ...fileTools, ...vaultTools, ...accessTools, ...bridgeTools, ...deviceTools, ...webTools, ...mailTools, ...visionTools, ...faceTools, ...trackTools, ...repoTools, ...keyringTools, ...recallTools, ...workTools };

/** Ollama's native tool format. */
export function toolSchemas(names = Object.keys(TOOLS)) {
  return names
    .filter((n) => TOOLS[n])
    .map((n) => ({ type: "function", function: { name: n, ...TOOLS[n].schema } }));
}

/**
 * Names the model reaches for that are not the names we chose.
 *
 * It calls `shell` about as often as `run_shell`, which cost a wasted step and
 * a "No such tool" every time before it guessed again. Arguing with a model
 * about vocabulary through the prompt is a losing game when a two-line alias
 * table settles it — the intent was never ambiguous.
 */
const ALIASES = {
  shell: "run_shell",
  bash: "run_shell",
  exec: "run_shell",
  execute_command: "run_shell",
  read: "read_file",
  cat: "read_file",
  ls: "list_dir",
  grep: "search_files",
  search: "search_files",
  write: "write_file",
  remember: "remember_fact",
  // "Who is that" is a question with many spellings and one answer. Left to
  // guess, the model reaches for `look` — which describes a face perfectly and
  // then names it from thin air, the exact failure who_is_there exists to stop.
  who: "who_is_there",
  whos_there: "who_is_there",
  identify_face: "who_is_there",
  recognize_face: "who_is_there",
  face_recognition: "who_is_there",
  remember_face: "learn_face",
  enroll_face: "learn_face",
  // "Do you have my repos" arrives in about six spellings and every one of them
  // used to end in a `find ~` that walked the whole disk. The index answers all
  // six, so the names route to it rather than to the shell.
  repos: "list_repos",
  list_repositories: "list_repos",
  git_repos: "list_repos",
  github_repos: "list_repos",
  gh: "github",
  git_status: "repo_status",
  secrets: "list_secrets",
  api_key: "get_secret",
  remember_secret: "save_secret",
  search_chats: "recall_chat",
  past_conversations: "recall_chat",
};

/**
 * A missing argument is not a negative result, and the difference decides
 * whether the model recovers.
 *
 * `edit_file` called without `find` searched the file for the string
 * "undefined", found nothing, and answered "Not found — read the file and match
 * the text exactly, including indentation." That is advice for a DIFFERENT
 * problem. It sends the model off to re-read the file and retry the identical
 * broken call, because nothing in the reply suggests the call itself was
 * malformed. `find_files` without `name` did the same: `Nothing named like
 * "undefined"`, phrased as an empty search rather than an absent argument.
 *
 * Checked here rather than in each tool, so every tool gets it and no future
 * one has to remember. The schemas already declare what is required.
 */
function missingArgs(tool, args) {
  const required = tool.schema?.parameters?.required || [];
  return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
}

/** `ctx` carries who is asking, so a tool can act on behalf of one agent. */
export async function callTool(name, args, ctx) {
  const tool = TOOLS[name] || TOOLS[ALIASES[name]];
  if (!tool) return `No such tool: ${name}`;

  const missing = missingArgs(tool, args || {});
  if (missing.length) {
    const props = tool.schema?.parameters?.properties || {};
    return (
      `${name} is missing ${missing.length === 1 ? "a required argument" : "required arguments"}: ` +
      missing.map((k) => `${k} (${props[k]?.description || "required"})`).join("; ") +
      `. Nothing was done — call it again with ${missing.join(" and ")}.`
    );
  }
  try {
    return coerceResult(name, await tool.run(args || {}, ctx));
  } catch (e) {
    return `${name} failed: ${e.message}`;
  }
}

/**
 * A tool result the model can actually read.
 *
 * `look` returned an object once and the loop did String() on it, so the model
 * was handed the literal text "[object Object]". It did not report an empty
 * result — it filled the gap with what a desk usually has, and invented an
 * MX Master 3 and an iPhone 15 Pro Max sitting on it. Two runs on 13 Aug show
 * exactly that: the tool call recorded as "[object Object]", followed by a
 * confident description of a desk nobody had looked at.
 *
 * That was fixed inside vision.mjs, on one tool, by making every path return a
 * string. This is the same fix made structural: there are thirty-eight tools and
 * any of them can grow a path that returns the wrong shape, and the symptom is
 * not an error — it is a plausible answer about something that was never seen.
 *
 * The two dangerous shapes get opposite treatment, because they mean opposite
 * things. An object HAS the information and only lost its formatting, so it is
 * serialised and handed over. Nothing at all means the tool genuinely produced
 * nothing, and the only safe thing to give a model then is a sentence telling it
 * so — silence is what invention grows in.
 */
export function coerceResult(name, value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) {
    return `${name} returned nothing at all. That is a bug in the tool, not an answer — ` +
           `say you could not get the information rather than describing what is usually there.`;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return `${name} returned something that could not be read (${typeof value}). ` +
           `Treat it as no answer and say so.`;
  }
}
