#!/usr/bin/env node
// bin/cleetus.mjs — `cleetus` in a terminal: a coding agent on the LOCAL model.
//
//   cleetus                    interactive session in the current directory
//   cleetus --self             same, but in ~/cleetusd (Cleetus working on Cleetus)
//   cleetus -p "fix the test"  one prompt, print the answer, exit
//   cleetus -c                 continue the last session in this directory
//   cleetus --yolo             no approval prompts for writes and shell
//   cleetus --model NAME       any Ollama model with tool support
//
// Same shape as Claude Code on purpose: the model reads freely, but every write,
// edit and shell command is shown first and needs a y/n (or "a" = always, for
// this session). Nothing leaves the machine: the model is Ollama on this Mac.
//
// Why not the daemon's ask(): that loop is Cleetus-the-assistant (vault, memory,
// 40+ tools, run logs in the vault). A coding session wants a small, sharp tool
// set rooted in the directory you typed `cleetus` in, and paths relative to it,
// where the daemon's file tools resolve relative paths against HOME.

import { readFile, writeFile, mkdir, readdir, stat, appendFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execFile, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline";
import os from "node:os";

const run = promisify(execFile);
const HOME = os.homedir();
const OLLAMA = process.env.OLLAMA_HOST?.replace(/\/$/, "") || "http://127.0.0.1:11434";
const STATE = join(HOME, ".cleetus");
const MAX_STEPS = 60;
const MAX_OUT = 20_000;

// ---------- args ----------
const argv = process.argv.slice(2);

// `cleetus chat ...` = talk to Cleetus HIMSELF (personality, memory, vault, all
// 24 agents), not the coding agent. Delegate to the daemon's chat REPL and keep
// this file about coding. Everything after `chat` is passed straight through.
if (argv[0] === "chat" || argv[0] === "talk") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [join(HOME, "cleetusd/bin/chat.mjs"), ...argv.slice(1)],
    { stdio: "inherit", cwd: join(HOME, "cleetusd") });
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {});   // hand the terminal to the child
}

const flag = (f) => { const i = argv.indexOf(f); if (i === -1) return false; argv.splice(i, 1); return true; };
const opt = (f) => { const i = argv.indexOf(f); if (i === -1) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
if (flag("--help") || flag("-h")) {
  console.log(`cleetus: two ways in

  cleetus chat            TALK to Cleetus himself (personality, memory, vault, all agents)
  cleetus chat "..."      one-shot question to Cleetus

  cleetus                 CODE with the local model, in this directory
  cleetus --self          code in ~/cleetusd (Cleetus works on itself)
  cleetus -p "prompt"     one-shot coding task
  cleetus -c              continue the last coding session here
  cleetus --yolo          skip approval prompts
  cleetus --model NAME    pick an Ollama model (default $CLEETUS_MODEL or qwen3.8-27b-heretic:q8_0)
  cleetus --think         show the model's reasoning (slower)

In a coding session: /help /compact /context /clear /model /think /yolo /cwd /exit
In chat: /agent <name> /clear /exit`);
  process.exit(0);
}
let MODEL = opt("--model") || process.env.CLEETUS_MODEL || "qwen3.8-27b-heretic:q8_0";
let YOLO = flag("--yolo");
let THINK = flag("--think");
const CONTINUE = flag("-c") || flag("--continue");
const SELF = flag("--self");
const oneShot = opt("-p") ?? opt("--print");
// Matches what Ollama already loads this model at (262144, same as cleetusd), so
// a turn never forces a reload. 32768 overflowed in ~30 tool calls, and Ollama
// silently drops the START of an overflowing prompt, so replies went blank.
const NUM_CTX = Number(process.env.CLEETUS_CTX || 262144);
if (SELF) process.chdir(join(HOME, "cleetusd"));
let CWD = process.cwd();

// ---------- colour ----------
const tty = process.stdout.isTTY;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), bold = c(1), mag = c(35);

// ---------- paths ----------
const P = (p) => {
  let s = String(p ?? "").trim() || ".";
  if (s.startsWith("~")) s = join(HOME, s.slice(1));
  return resolve(CWD, s);
};
const show = (p) => { const r = relative(CWD, p); return r && !r.startsWith("..") ? r : p.replace(HOME, "~"); };

// ---------- approval ----------
let rl = null;
const always = new Set();
function ask(q) {
  return new Promise((res) => rl.question(q, (a) => res(a.trim().toLowerCase())));
}
async function approve(kind, preview) {
  if (YOLO || always.has(kind)) return true;
  if (oneShot !== null && !process.stdin.isTTY) return false;
  console.log(preview);
  const a = await ask(yellow(`  allow ${kind}? [y]es / [n]o / [a]lways this session: `));
  if (a === "a") { always.add(kind); return true; }
  return a === "y" || a === "yes" || a === "";
}

function diffPreview(before, after, path) {
  const a = before.split("\n"), b = after.split("\n");
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const out = [bold(`  ${show(path)}`) + dim(`  @ line ${s + 1}`)];
  const ctx = Math.max(0, s - 2);
  for (let i = ctx; i < s; i++) out.push(dim(`    ${a[i]}`));
  const del = a.slice(s, ea + 1), add = b.slice(s, eb + 1);
  const cap = (arr, col, sign) => {
    arr.slice(0, 40).forEach((l) => out.push(col(`  ${sign} ${l}`)));
    if (arr.length > 40) out.push(dim(`    ... ${arr.length - 40} more lines`));
  };
  cap(del, red, "-"); cap(add, green, "+");
  return out.join("\n");
}

// ---------- tools ----------
const TOOLS = {
  read_file: {
    description: "Read a text file. Paths are relative to the working directory. Always read before editing.",
    params: { path: "string", offset: "number? 1-indexed first line", limit: "number? lines (default 400)" },
    async run({ path, offset, limit }) {
      const p = P(path);
      if (!existsSync(p)) return `No such file: ${show(p)}`;
      if ((await stat(p)).isDirectory()) return `${show(p)} is a directory; use list_dir.`;
      const lines = (await readFile(p, "utf8")).split("\n");
      const from = Math.max(0, (offset || 1) - 1), n = limit || 400;
      const body = lines.slice(from, from + n).map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join("\n");
      const more = from + n < lines.length ? `\n[${lines.length - from - n} more lines; read again with offset=${from + n + 1}]` : "";
      return (body + more).slice(0, MAX_OUT * 3) || "(empty file)";
    },
  },
  list_dir: {
    description: "List a directory (default: the working directory).",
    params: { path: "string?" },
    async run({ path }) {
      const p = P(path || ".");
      if (!existsSync(p)) return `No such directory: ${show(p)}`;
      const es = await readdir(p, { withFileTypes: true });
      return es.filter((e) => e.name !== ".DS_Store").map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort().join("\n").slice(0, 8000) || "(empty)";
    },
  },
  grep: {
    description: "Search file contents with ripgrep (regex). Returns file:line:text.",
    params: { pattern: "string", path: "string? directory or file", glob: "string? e.g. *.mjs" },
    async run({ pattern, path, glob }) {
      const args = ["-n", "--no-heading", "--color=never", "--max-count=20", "--max-filesize=2M"];
      if (glob) args.push("--glob", glob);
      args.push("--", pattern, P(path || "."));
      try {
        const { stdout } = await run("rg", args, { timeout: 30000, maxBuffer: 8e6, cwd: CWD });
        return stdout.split("\n").slice(0, 150).join("\n").replaceAll(CWD + "/", "") || "no matches";
      } catch (e) {
        return e.code === 1 ? "no matches" : `grep failed: ${(e.stderr || e.message).slice(0, 400)}`;
      }
    },
  },
  glob: {
    description: "Find files by name pattern (e.g. '**/*.test.mjs'). Skips node_modules and .git.",
    params: { pattern: "string", path: "string?" },
    async run({ pattern, path }) {
      try {
        const { stdout } = await run("rg", ["--files", "--glob", pattern, P(path || ".")], { timeout: 30000, maxBuffer: 8e6, cwd: CWD });
        return stdout.split("\n").slice(0, 200).join("\n").replaceAll(CWD + "/", "") || "no files";
      } catch (e) {
        return e.code === 1 ? "no files" : `glob failed: ${(e.stderr || e.message).slice(0, 400)}`;
      }
    },
  },
  edit_file: {
    description: "Replace an exact string in a file. old_string must appear exactly once (include surrounding lines to make it unique) unless replace_all is true. Preferred over write_file for changes.",
    params: { path: "string", old_string: "string", new_string: "string", replace_all: "boolean?" },
    async run({ path, old_string, new_string, replace_all }) {
      const p = P(path);
      if (!existsSync(p)) return `No such file: ${show(p)}. Use write_file to create it.`;
      const text = await readFile(p, "utf8");
      const n = text.split(old_string).length - 1;
      if (!old_string || n === 0) return `old_string not found in ${show(p)}. Read the file and copy the text exactly (indentation included, no line-number prefixes).`;
      if (n > 1 && !replace_all) return `old_string appears ${n} times in ${show(p)}. Add surrounding lines to make it unique, or set replace_all.`;
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
      if (!(await approve("edits", diffPreview(text, next, p)))) return "The user declined this edit. Ask what they want instead.";
      await backup(p, text);
      await writeFile(p, next);
      return `Edited ${show(p)}`;
    },
  },
  write_file: {
    description: "Create or overwrite a whole file. For existing files prefer edit_file.",
    params: { path: "string", content: "string" },
    async run({ path, content }) {
      const p = P(path);
      const before = existsSync(p) ? await readFile(p, "utf8") : "";
      const preview = before ? diffPreview(before, String(content), p) : bold(`  new file ${show(p)}`) + dim(` (${String(content).split("\n").length} lines)`) + "\n" + String(content).split("\n").slice(0, 25).map((l) => green(`  + ${l}`)).join("\n");
      if (!(await approve("edits", preview))) return "The user declined this write. Ask what they want instead.";
      if (before) await backup(p, before);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, String(content));
      return `Wrote ${show(p)}`;
    },
  },
  bash: {
    description: "Run a shell command (zsh) in the working directory. Use for git, tests, builds, installs. 2 min timeout. Not interactive: never run editors, pagers or servers that don't exit.",
    params: { command: "string", timeout_s: "number? default 120" },
    async run({ command, timeout_s }) {
      const safe = /^\s*(ls|pwd|cat|head|tail|wc|git (status|diff|log|show|branch)|rg|grep|find|which|echo|node -v|python3? --version)\b[^;&|>]*$/.test(command);
      if (!safe && !(await approve("shell", `  ${bold("$")} ${cyan(command)}`))) return "The user declined this command. Ask what they want instead.";
      return new Promise((res) => {
        const ch = spawn("/bin/zsh", ["-lc", command], { cwd: CWD, env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" } });
        let out = "";
        const add = (d) => { out += d; if (out.length > 400_000) out = out.slice(-200_000); };
        ch.stdout.on("data", add); ch.stderr.on("data", add);
        const t = setTimeout(() => { ch.kill("SIGKILL"); out += "\n[killed: timeout]"; }, (timeout_s || 120) * 1000);
        ch.on("close", (code) => {
          clearTimeout(t);
          const s = out.length > MAX_OUT ? out.slice(0, MAX_OUT / 2) + `\n...[${out.length - MAX_OUT} chars cut]...\n` + out.slice(-MAX_OUT / 2) : out;
          res(`exit ${code}\n${s.trim()}`);
        });
      });
    },
  },
};

async function backup(p, text) {
  const dir = join(STATE, "backups", new Date().toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Date.now()}-${p.replaceAll("/", "_")}`), text).catch(() => {});
}

const toolSchemas = Object.entries(TOOLS).map(([name, t]) => {
  const properties = {}, required = [];
  for (const [k, v] of Object.entries(t.params)) {
    const [type, ...rest] = v.split(" ");
    const optional = type.endsWith("?");
    properties[k] = { type: type.replace("?", ""), ...(rest.length ? { description: rest.join(" ") } : {}) };
    if (!optional) required.push(k);
  }
  return { type: "function", function: { name, description: t.description, parameters: { type: "object", properties, required } } };
});

// ---------- system prompt ----------
function projectNotes() {
  const out = [];
  for (const dir of new Set([CWD, gitRoot()])) {
    for (const f of ["CLEETUS.md", "CLAUDE.md", "AGENTS.md"]) {
      const p = join(dir, f);
      if (dir === HOME || !existsSync(p)) continue;   // ~/AGENTS.md is the Codex rulebook, not a project note
      try { out.push(`--- ${show(p)} ---\n${readFileSync(p, "utf8").slice(0, 12000)}`); } catch {}
    }
  }
  return out.join("\n\n");
}
function gitRoot() {
  try { return execSync("git rev-parse --show-toplevel", { cwd: CWD, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || CWD; }
  catch { return CWD; }
}

function systemPrompt() {
  const notes = projectNotes();
  let git = "";
  try { git = execSync("git status --short --branch 2>/dev/null | head -25", { cwd: CWD, encoding: "utf8", timeout: 5000 }); } catch {}
  return `You are Cleetus, Grayson's local AI, working as a coding agent in his terminal on his Mac (macOS, zsh). You run entirely on this machine via Ollama (model ${MODEL}).

Working directory: ${CWD}
Date: ${new Date().toString()}
${git ? `Git:\n${git}` : "Not a git repository."}

Your own source code is ~/cleetusd (daemon: src/, tools: src/tools/, this CLI: bin/cleetus.mjs). When asked to improve yourself, work there like any other codebase: read, edit, run its tests.

How to work:
- Investigate before changing: list_dir, glob, grep, read_file. Never guess file contents.
- Make changes with edit_file (exact old_string copied from read_file output WITHOUT the line-number prefix). Use write_file only for new files.
- After changing code, verify: run the tests, the build, or the script with bash, and read the output. Say plainly if something failed.
- Keep changes focused on what was asked. Match the surrounding code style.
- If the user declines an action, stop and ask what they want.
- Be concise. When done, say what changed and how you checked it.
- Never write em dashes in files you create.
${notes ? `\nProject instructions:\n${notes}` : ""}`;
}

// ---------- model ----------
async function* stream(messages, signal) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: toolSchemas, stream: true, think: THINK,
      options: { num_ctx: NUM_CTX, temperature: 0.3 } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

let current = null;   // AbortController of the in-flight turn
let lastCtx = 0;      // prompt+eval tokens Ollama reported for the last call

// Keep the conversation inside the window, without ever losing the session.
//
// Tier 1 (70% full): old tool outputs (file dumps, diffs, test logs) are most of
// the bulk and the least needed later, so they shrink to a stub; the model can
// re-run the tool. Cheap, no model call.
// Tier 2 (80% full, or /compact): the model writes a working summary of the
// older part of the session (goal, decisions, files changed, state, next steps)
// and that summary replaces it. The last KEEP messages stay verbatim, and the
// full transcript is archived to ~/.cleetus/sessions/archive/ first, so nothing
// is ever actually thrown away. This is what makes /clear unnecessary.
const KEEP = 12;
const STUB = 600;
const SUMMARIZE_AT = Number(process.env.CLEETUS_COMPACT_AT || 0.8);
const TRIM_AT = Math.min(0.7, SUMMARIZE_AT);
const SUMMARY_TAG = "[Session summary. Earlier messages were compacted to fit the context window; the full transcript is archived.]";
function estTokens(ms) { return Math.ceil(ms.reduce((n, m) => n + String(m.content || "").length + JSON.stringify(m.tool_calls || "").length, 0) / 3.2); }
function trimToolOutputs(ms, budget, used = estTokens(ms)) {
  if (used <= budget * TRIM_AT) return 0;
  let freed = 0;
  for (let i = 1; i < ms.length - KEEP; i++) {
    const m = ms[i];
    if (m.role !== "tool" || String(m.content).length <= STUB + 100 || m.compacted) continue;
    const was = m.content.length;
    m.content = m.content.slice(0, STUB) + `\n...[older output trimmed to save context (${was} chars); re-run the tool if you need it]`;
    m.compacted = true; freed += was - m.content.length;
    if (used - freed / 3.2 <= budget * 0.5) break;
  }
  return freed;
}
// Where the verbatim tail starts. Never on a tool result: one without the
// assistant message that called it is an orphan the model cannot place.
function cutPoint(ms) {
  let i = Math.max(1, ms.length - KEEP);
  while (i > 1 && ms[i].role === "tool") i--;
  return i;
}
const SUMMARIZE = `Pause the task. Older messages in this session are about to be removed to free context, and this summary will replace them. Write a working summary so you can continue seamlessly. Include:
1. Grayson's goal(s) and every instruction or preference he gave, in his words where it matters.
2. What has been done: exact file paths created or changed, and why.
3. Key facts learned: commands, paths, ports, errors and their causes, test results.
4. Current state: what is finished, what is in progress, what is broken.
5. The next concrete steps.
Be specific; exact names beat prose. Plain text, no tool calls, under 1500 words.`;
async function summarizeOlder(ms) {
  const cut = cutPoint(ms);
  if (cut <= 2) return { ok: false, why: "nothing old enough to compact" };
  const older = ms.slice(0, cut);
  // The summary request reuses the exact prefix (same system prompt, same tools),
  // so Ollama's KV cache covers it and only the summary itself is generated.
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [...older, { role: "user", content: SUMMARIZE }], tools: toolSchemas,
      stream: false, think: false, options: { num_ctx: NUM_CTX, temperature: 0.2 } }),
  });
  if (!res.ok) return { ok: false, why: `ollama ${res.status}` };
  const summary = String((await res.json()).message?.content || "").trim();
  if (summary.length < 200) return { ok: false, why: "the model returned no usable summary" };
  // If the request that started the current work is being compacted, keep it
  // word for word. A paraphrase of the task is how an agent drifts off it.
  const lastUser = older.filter((m) => m.role === "user" && !String(m.content).startsWith(SUMMARY_TAG)).at(-1);
  const pinned = lastUser && !ms.slice(cut).some((m) => m.role === "user") ? `\n\nGrayson's current request, verbatim:\n${lastUser.content}` : "";
  const archived = await archive(ms);
  const before = estTokens(ms);
  ms.splice(1, cut - 1, { role: "user", content: `${SUMMARY_TAG}\n\n${summary}${pinned}` });
  return { ok: true, removed: cut - 1, before, after: estTokens(ms), archived };
}
async function keepInWindow(ms, { force = false } = {}) {
  const overhead = Math.ceil(JSON.stringify(toolSchemas).length / 3.2);
  let used = Math.max(lastCtx, estTokens(ms) + overhead);
  const freed = trimToolOutputs(ms, NUM_CTX, used);
  if (freed) { lastCtx = 0; used = estTokens(ms) + overhead; console.log(dim(`  trimmed old tool output (${Math.round(freed / 1000)}k chars) to stay inside the ${NUM_CTX} context`)); }
  if (!force && used <= NUM_CTX * SUMMARIZE_AT) return;
  const spin = tty ? startSpinner() : null;
  let r;
  try { r = await summarizeOlder(ms); } catch (e) { r = { ok: false, why: e.message }; } finally { spin?.stop(); }
  if (r.ok) { lastCtx = 0; console.log(dim(`  compacted ${r.removed} older messages into a summary (~${Math.round(r.before / 1000)}k -> ~${Math.round(r.after / 1000)}k tokens); full transcript kept at ${show(r.archived)}`)); }
  else console.log(yellow(`  could not compact: ${r.why}`));
}

async function turn(messages) {
  for (let step = 0; step < MAX_STEPS; step++) {
    await keepInWindow(messages);
    current = new AbortController();
    let text = "", thinking = "", calls = [], started = false, stats = null;
    const spin = tty ? startSpinner() : null;
    try {
      for await (const ev of stream(messages, current.signal)) {
        const m = ev.message || {};
        if (m.thinking) { spin?.stop(); if (THINK) process.stdout.write(dim(m.thinking)); thinking += m.thinking; }
        if (m.content) {
          spin?.stop();
          if (!started && THINK && thinking) process.stdout.write("\n");
          started = true; text += m.content; process.stdout.write(m.content);
        }
        if (m.tool_calls?.length) calls.push(...m.tool_calls);
        if (ev.done) stats = ev;
      }
    } catch (e) {
      spin?.stop();
      if (e.name === "AbortError") { console.log(dim("\n  [interrupted]")); messages.push({ role: "assistant", content: text + " [interrupted by user]" }); return; }
      throw e;
    } finally { spin?.stop(); current = null; }
    if (text && !text.endsWith("\n")) process.stdout.write("\n");
    messages.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    if (stats) lastCtx = (stats.prompt_eval_count || 0) + (stats.eval_count || 0);
    if (stats && tty) {
      const tps = stats.eval_count && stats.eval_duration ? (stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1) : "?";
      const ctx = lastCtx;
      if (!calls.length) console.log(dim(`  ${tps} tok/s · context ${ctx}/${NUM_CTX}`));
      // No warning needed: the next step compacts on its own past 80%.
    }
    if (!calls.length && !text.trim()) {
      // A blank reply with no tool call is how an overflowing prompt looks from here.
      console.log(yellow(`  the model returned nothing (context ${lastCtx || "?"}/${NUM_CTX}). Try again, or /compact.`));
    }
    if (!calls.length) return;
    for (const call of calls) {
      const name = call.function?.name; let args = call.function?.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      const t = TOOLS[name];
      const label = Object.values(args).map((v) => String(v)).join(" ").replace(/\s+/g, " ").slice(0, 90);
      console.log(mag(`  ● ${name}`) + dim(` ${label}`));
      let result;
      try { result = t ? await t.run(args) : `Unknown tool ${name}. Tools: ${Object.keys(TOOLS).join(", ")}`; }
      catch (e) { result = `Tool error: ${e.message}`; }
      const first = String(result).split("\n").slice(0, 3).join(" | ");
      console.log(dim(`    ${first.slice(0, 140)}`));
      messages.push({ role: "tool", tool_name: name, content: String(result) });
    }
  }
  console.log(yellow(`  stopped after ${MAX_STEPS} steps`));
}

function startSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; let i = 0, on = true;
  const t0 = Date.now();
  const iv = setInterval(() => process.stdout.write(`\r${cyan(frames[i++ % 10])} ${dim(`thinking ${((Date.now() - t0) / 1000).toFixed(0)}s`)}  `), 100);
  return { stop() { if (on) { on = false; clearInterval(iv); process.stdout.write("\r\x1b[K"); } } };
}

// ---------- sessions ----------
const sessionDir = join(STATE, "sessions");
const sessionKey = CWD.replaceAll("/", "_");
async function loadLast() {
  try {
    const files = (await readdir(sessionDir)).filter((f) => f.startsWith(sessionKey + "__")).sort();
    if (!files.length) return null;
    return JSON.parse(await readFile(join(sessionDir, files.at(-1)), "utf8"));
  } catch { return null; }
}
let sessionFile = null;
async function save(messages) {
  await mkdir(sessionDir, { recursive: true });
  sessionFile ??= join(sessionDir, `${sessionKey}__${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(sessionFile, JSON.stringify(messages));
}
async function archive(messages) {
  const dir = join(sessionDir, "archive");
  await mkdir(dir, { recursive: true });
  const f = join(dir, `${sessionKey}__${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(f, JSON.stringify(messages));
  return f;
}

// ---------- main ----------
async function checkModel() {
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: MODEL }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `model "${MODEL}" is not installed in Ollama (ollama list)`;
    const caps = (await r.json()).capabilities || [];
    if (!caps.includes("tools")) return `model "${MODEL}" does not support tool calls`;
    return null;
  } catch { return `Ollama is not reachable at ${OLLAMA} (is it running?)`; }
}

rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, historySize: 500 });
const problem = await checkModel();
if (problem) { console.error(red(`cleetus: ${problem}`)); process.exit(1); }

let messages = [{ role: "system", content: systemPrompt() }];
if (CONTINUE) {
  const prev = await loadLast();
  if (prev) { messages = [{ role: "system", content: systemPrompt() }, ...prev.filter((m) => m.role !== "system")]; console.log(dim(`  continuing (${prev.length} messages)`)); }
}

if (oneShot !== null) {
  messages.push({ role: "user", content: oneShot || (await readFile("/dev/stdin", "utf8")) });
  await turn(messages); await save(messages); rl.close(); process.exit(0);
}

console.log(`${bold(cyan("cleetus"))} ${dim(`· ${MODEL} · local · ${show(CWD) === "" ? CWD : CWD.replace(HOME, "~")}`)}`);
console.log(dim(`  /help for commands · ctrl-c interrupts · ${YOLO ? yellow("yolo: no approval prompts") : "writes and shell ask first"}`));

let lastSigint = 0;
rl.on("SIGINT", () => {
  if (current) { current.abort(); return; }
  if (Date.now() - lastSigint < 1500) { console.log(); process.exit(0); }
  lastSigint = Date.now(); console.log(dim("\n  (ctrl-c again to exit)")); rl.prompt();
});

const HELP = `  /compact       summarize older messages now to free context (automatic at 80%)
  /context       show how full the context window is
  /clear         start a fresh conversation (the old one stays on disk)
  /model [name]  show or switch the Ollama model
  /think         toggle showing reasoning (currently ${THINK ? "on" : "off"})
  /yolo          toggle approval prompts
  /cwd [dir]     show or change the working directory
  /exit          quit`;

while (true) {
  const line = await new Promise((res) => rl.question(bold(green("› ")), res)).catch(() => null);
  if (line === null) break;
  const q = line.trim();
  if (!q) continue;
  if (q.startsWith("/")) {
    const [cmd, ...rest] = q.slice(1).split(/\s+/); const arg = rest.join(" ");
    if (cmd === "exit" || cmd === "quit") break;
    else if (cmd === "help") console.log(HELP);
    else if (cmd === "compact") { await keepInWindow(messages, { force: true }); await save(messages).catch(() => {}); }
    else if (cmd === "context") { const est = estTokens(messages) + Math.ceil(JSON.stringify(toolSchemas).length / 3.2); console.log(dim(`  ~${Math.max(lastCtx, est)} of ${NUM_CTX} tokens (${Math.round(100 * Math.max(lastCtx, est) / NUM_CTX)}%), ${messages.length} messages; compacts at ${Math.round(SUMMARIZE_AT * 100)}%`)); }
    else if (cmd === "clear") { messages = [{ role: "system", content: systemPrompt() }]; sessionFile = null; console.log(dim("  cleared")); }
    else if (cmd === "think") { THINK = !THINK; console.log(dim(`  reasoning ${THINK ? "shown" : "off"}`)); }
    else if (cmd === "yolo") { YOLO = !YOLO; console.log(YOLO ? yellow("  yolo on: writes and shell run without asking") : dim("  approvals back on")); }
    else if (cmd === "model") {
      if (arg) { const old = MODEL; MODEL = arg; const p = await checkModel(); if (p) { console.log(red(`  ${p}`)); MODEL = old; } else { messages[0].content = systemPrompt(); console.log(dim(`  model: ${MODEL}`)); } }
      else console.log(dim(`  ${MODEL}`));
    } else if (cmd === "cwd") {
      if (arg) { const d = P(arg); if (existsSync(d) && statSync(d).isDirectory()) { CWD = d; process.chdir(d); messages[0].content = systemPrompt(); } else console.log(red("  not a directory")); }
      console.log(dim(`  ${CWD}`));
    } else console.log(dim(`  unknown command; /help`));
    continue;
  }
  messages.push({ role: "user", content: q });
  try { await turn(messages); } catch (e) { console.log(red(`  error: ${e.message}`)); }
  await save(messages).catch(() => {});
}
rl.close();
process.exit(0);
