#!/usr/bin/env node
// bin/cleetus.mjs: `cleetus` in a terminal, a coding agent on the LOCAL model.
//
//   cleetus                    interactive session in the current directory
//   cleetus --self             same, but in ~/cleetusd (Cleetus working on Cleetus)
//   cleetus -p "fix the test"  one prompt, print the answer, exit
//   cleetus -c                 continue the last session in this directory
//   cleetus --yolo             no approval prompts for writes and shell
//   cleetus --model NAME       any Ollama model with tool support
//
// Same shape as Claude Code on purpose: the model reads freely, but every write,
// edit and shell command is shown first and needs a yes (or "always" for this
// session). Nothing leaves the machine: the model is Ollama on this Mac.
//
// Every interactive session is also LIVE (src/codelive.mjs): it registers in
// ~/.cleetus/live and listens on a private socket, so the phone (cleetusai.com/code,
// through cleetusd) can watch it, send it messages, answer its approvals and
// interrupt it. Terminal and phone are equal; whoever answers first wins.
//
// It must not lose a session. The conversation is written to disk after EVERY
// message (atomically), not at the end of a turn; Ollama hiccups are retried;
// an unexpected error is logged to ~/.cleetus/crash.log and the prompt comes
// back instead of the process dying; closing the terminal saves and says how to
// resume. The first version exited silently when stdin closed and only saved
// once a whole turn finished, which is how a first session vanished with no file.
//
// Why not the daemon's ask(): that loop is Cleetus-the-assistant (vault, memory,
// 40+ tools, run logs in the vault). A coding session wants a small, sharp tool
// set rooted in the directory you typed `cleetus` in, and paths relative to it.

import { readFile, writeFile, mkdir, readdir, stat, appendFile, rename } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, basename } from "node:path";
import { execFile, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline";
import os from "node:os";
import { LiveSession } from "../src/codelive.mjs";
import {
  setColor, dim, bold, red, green, yellow, cyan, mag, gray, amber, onGray,
  box, toolLabel, toolSummary, mdRenderer, pickVerb, spinnerFrame, MODES, statusLine, vis, strip,
} from "../src/coderui.mjs";

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
  cleetus --resume FILE   continue a specific saved session
  cleetus --yolo          skip approval prompts
  cleetus --model NAME    pick an Ollama model (default $CLEETUS_MODEL or qwen3.8-27b-heretic:q8_0)
  cleetus --think         show the model's reasoning (slower)

Every coding session can be watched and driven from the phone at cleetusai.com/code.
In a session: /help /compact /context /phone /clear /model /think /mode /cwd /exit`);
  process.exit(0);
}
let MODEL = opt("--model") || process.env.CLEETUS_MODEL || "qwen3.8-27b-heretic:q8_0";
let MODE = flag("--yolo") ? "yolo" : "ask";   // ask | edits (auto-accept edits) | yolo
let THINK = flag("--think");
const CONTINUE = flag("-c") || flag("--continue");
const RESUME = opt("--resume");
const SELF = flag("--self");
const ORIGIN = opt("--origin") === "phone" ? "phone" : "terminal";
const LAUNCH = opt("--launch");
const oneShot = opt("-p") ?? opt("--print");
// Matches what Ollama already loads this model at (262144, same as cleetusd), so
// a turn never forces a reload. 32768 overflowed in ~30 tool calls, and Ollama
// silently drops the START of an overflowing prompt, so replies went blank.
const NUM_CTX = Number(process.env.CLEETUS_CTX || 262144);
if (SELF) process.chdir(join(HOME, "cleetusd"));
let CWD = process.cwd();

// ---------- output ----------
const tty = !!process.stdout.isTTY;
const interactive = tty && !!process.stdin.isTTY;
setColor(tty);
const cols = () => Math.max(40, Math.min(process.stdout.columns || 80, 140));
let muted = false;         // hide readline's echo while a turn prints
let messages = [];         // the conversation; [0] is the system prompt once started
function out(s) { try { process.stdout.write(s); } catch {} }
function line(s = "") { out(s + "\n"); }

// ---------- paths ----------
const P = (p) => {
  let s = String(p ?? "").trim() || ".";
  if (s.startsWith("~")) s = join(HOME, s.slice(1));
  return resolve(CWD, s);
};
const show = (p) => { const r = relative(CWD, p); return r === "" ? "." : !r.startsWith("..") ? r : p.replace(HOME, "~"); };
const tilde = (p) => p.replace(HOME, "~");

// ---------- approval ----------
let rl = null;
let live = null;
let killTool = null;       // set while a shell command runs, so an interrupt can stop it
const always = new Set();
const ANSWERS = { "": "y", "1": "y", y: "y", yes: "y", "2": "a", a: "a", always: "a", "3": "n", n: "n", no: "n" };
const WORD = { y: "yes", a: "yes, always this session", n: "no" };
async function approve(kind, preview, title = kind) {
  if (MODE === "yolo" || (MODE === "edits" && kind === "edits") || always.has(kind)) return true;
  if (!interactive && !live) return false;          // a piped one-shot has nobody to ask
  spinner.stop();
  const q = kind === "edits" ? "Do you want to make this change?" : "Do you want to run this?";
  if (tty) {
    line("");
    line(amber(`╭─ ${title} ${"─".repeat(Math.max(0, cols() - vis(title) - 5))}╮`));
    for (const l of String(preview).split("\n").slice(0, 60)) line(l);
    line("");
    line(`  ${bold(q)}`);
    line(`  ${amber("1.")} Yes`);
    line(`  ${amber("2.")} Yes, and don't ask again for ${kind === "edits" ? "edits" : "shell commands"} this session`);
    line(`  ${amber("3.")} No, and tell Cleetus what to do instead`);
    if (live) line(gray(`  (or answer from your phone)`));
    line(amber(`╰${"─".repeat(cols() - 2)}╯`));
  }
  const phone = live ? live.requestApproval(kind, `${title}\n\n${strip(preview)}`) : null;
  const typed = interactive ? readLine(amber("  ❯ ")).then((a) => ({ a: a === null ? "n" : (ANSWERS[a.trim().toLowerCase()] || "n"), by: "terminal" })) : new Promise(() => {});
  const r = await Promise.race([typed, phone ? phone.promise.then((a) => ({ a, by: "phone" })) : new Promise(() => {})]);
  if (r.by === "phone") { cancelLine(); line(gray(`  ⎿  answered from your phone: ${WORD[r.a]}`)); }
  else if (phone) live.settleApproval(phone.aid, r.a, "terminal");
  muted = true;
  if (r.a === "a") { always.add(kind); if (kind === "edits" && MODE === "ask") MODE = "edits"; return true; }
  return r.a === "y";
}

function diffPreview(before, after, path) {
  const a = before.split("\n"), b = after.split("\n");
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const out = [bold(`  ${show(path)}`) + dim(`  @ line ${s + 1}`)];
  const ctx = Math.max(0, s - 2);
  for (let i = ctx; i < s; i++) out.push(dim(`  ${String(i + 1).padStart(4)}   ${a[i]}`));
  const del = a.slice(s, ea + 1), add = b.slice(s, eb + 1);
  const cap = (arr, col, sign, start) => {
    arr.slice(0, 40).forEach((l, i) => out.push(col(`  ${String(start + i).padStart(4)} ${sign} ${l}`)));
    if (arr.length > 40) out.push(dim(`         ... ${arr.length - 40} more lines`));
  };
  cap(del, red, "-", s + 1); cap(add, green, "+", s + 1);
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
      if (!(await approve("edits", diffPreview(text, next, p), `Edit ${show(p)}`))) return "The user declined this edit. Ask what they want instead.";
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
      if (!(await approve("edits", preview, before ? `Overwrite ${show(p)}` : `Create ${show(p)}`))) return "The user declined this write. Ask what they want instead.";
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
      if (!safe && !(await approve("shell", `  ${bold("$")} ${cyan(command)}`, "Run a shell command"))) return "The user declined this command. Ask what they want instead.";
      return new Promise((res) => {
        const ch = spawn("/bin/zsh", ["-lc", command], { cwd: CWD, env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" } });
        killTool = () => { ch.kill("SIGTERM"); out += "\n[stopped: interrupted by user]"; };
        let out = "";
        const add = (d) => { out += d; if (out.length > 400_000) out = out.slice(-200_000); };
        ch.stdout.on("data", add); ch.stderr.on("data", add);
        const t = setTimeout(() => { ch.kill("SIGKILL"); out += "\n[killed: timeout]"; }, (timeout_s || 120) * 1000);
        ch.on("close", (code) => {
          clearTimeout(t); killTool = null;
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
const RETRY_MS = [2000, 5000, 10000, 20000];
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
});
function note(text, bad = false) { line((bad ? yellow : gray)(`  ${text}`)); live?.emit("notice", { text, bad }); }

// Ollama goes away briefly more often than you would think: a model reload when
// another caller asks for a different context size, a restart, the Mac waking.
// A coding session should wait that out, not throw away the turn.
async function openStream(messages, signal) {
  for (let i = 0; ; i++) {
    let why;
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: messages.map(wire), tools: toolSchemas, stream: true, think: THINK,
          options: { num_ctx: NUM_CTX, temperature: 0.3 } }),
      });
      if (res.ok) return res;
      const body = (await res.text()).slice(0, 300);
      if (res.status < 500) throw Object.assign(new Error(`ollama ${res.status}: ${body}`), { fatal: true });
      why = `Ollama answered ${res.status}`;
    } catch (e) {
      if (e.name === "AbortError" || e.fatal) throw e;
      why = `Ollama not answering (${e.cause?.code || e.message})`;
    }
    if (i >= RETRY_MS.length) throw new Error(`${why}; gave up after ${RETRY_MS.length} retries. Your message is saved; send it again when Ollama is back.`);
    note(`${why}; retrying in ${RETRY_MS[i] / 1000}s`, true);
    await sleep(RETRY_MS[i], signal);
  }
}
async function* stream(messages, signal) {
  const res = await openStream(messages, signal);
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue;
      let ev; try { ev = JSON.parse(l); } catch { continue; }   // one bad line must not end the turn
      if (ev.error) throw new Error(`ollama: ${ev.error}`);
      yield ev;
    }
  }
}
// Only what Ollama needs goes over the wire; bookkeeping fields stay local.
const wire = (m) => { const { compacted, from, ...rest } = m; return rest; };

let current = null;   // AbortController of the in-flight model call
let busy = false;     // a turn is running
let stopFlag = false; // an interrupt arrived during the turn
let lastCtx = 0;      // prompt+eval tokens Ollama reported for the last call

function interrupt() {
  if (!busy) return;
  stopFlag = true;
  current?.abort();
  killTool?.();
}

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
    body: JSON.stringify({ model: MODEL, messages: [...older, { role: "user", content: SUMMARIZE }].map(wire), tools: toolSchemas,
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
  if (freed) { lastCtx = 0; used = estTokens(ms) + overhead; note(`trimmed old tool output (${Math.round(freed / 1000)}k chars) to stay inside the ${NUM_CTX} context`); persistSoon(); }
  if (!force && used <= NUM_CTX * SUMMARIZE_AT) return;
  spinner.start("Compacting the conversation");
  let r;
  try { r = await summarizeOlder(ms); } catch (e) { r = { ok: false, why: e.message }; } finally { spinner.stop(); }
  if (r.ok) {
    lastCtx = 0; persistSoon();
    note(`compacted ${r.removed} older messages into a summary (~${Math.round(r.before / 1000)}k -> ~${Math.round(r.after / 1000)}k tokens); full transcript kept at ${tilde(r.archived)}`);
    live?.emit("compact", { removed: r.removed });
  } else note(`could not compact: ${r.why}`, true);
}

// ---------- a turn ----------
function add(m) { messages.push(m); persistSoon(); }

async function turn(messages) {
  busy = true; stopFlag = false;
  live?.setState("working");
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      await keepInWindow(messages);
      if (stopFlag) { note("⎿  Interrupted"); return; }
      current = new AbortController();
      let text = "", thinking = "", calls = [], stats = null, pending = "", printed = false;
      const md = mdRenderer();
      let deltaBuf = "", deltaTimer = null;
      const flushDelta = () => { if (deltaBuf) live?.emit("delta", { text: deltaBuf }); deltaBuf = ""; deltaTimer = null; };
      const printLine = (l) => { line((printed ? "  " : `${bold("⏺")} `) + md(l)); printed = true; };
      spinner.start();
      try {
        for await (const ev of stream(messages, current.signal)) {
          const m = ev.message || {};
          if (m.thinking) {
            thinking += m.thinking;
            if (THINK) { spinner.stop(); out(dim(m.thinking)); } else spinner.extra(`${Math.round(thinking.length / 4)} thinking tokens`);
          }
          if (m.content) {
            spinner.stop();
            if (!text && THINK && thinking) line("");
            text += m.content; pending += m.content; deltaBuf += m.content;
            if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 400);
            let i; while ((i = pending.indexOf("\n")) >= 0) { printLine(pending.slice(0, i)); pending = pending.slice(i + 1); }
          }
          if (m.tool_calls?.length) calls.push(...m.tool_calls);
          if (ev.done) stats = ev;
        }
      } catch (e) {
        spinner.stop(); clearTimeout(deltaTimer);
        if (e.name === "AbortError") {
          if (pending) printLine(pending);
          line(gray("  ⎿  Interrupted. What should Cleetus do instead?"));
          add({ role: "assistant", content: text + " [interrupted by user]" });
          live?.emit("assistant", { text: (text ? text + "\n\n" : "") + "[interrupted]" });
          return;
        }
        throw e;
      } finally { spinner.stop(); current = null; }
      clearTimeout(deltaTimer); deltaBuf = "";      // the whole text below supersedes the deltas
      if (pending) printLine(pending);
      add({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      if (text.trim()) live?.emit("assistant", { text });
      if (stats) lastCtx = (stats.prompt_eval_count || 0) + (stats.eval_count || 0);
      if (!calls.length && !text.trim()) {
        // A blank reply with no tool call is how an overflowing prompt looks from here.
        note(`the model returned nothing (context ${lastCtx || "?"}/${NUM_CTX}). Try again, or /compact.`, true);
      }
      if (!calls.length) {
        if (stats && tty) {
          const tps = stats.eval_count && stats.eval_duration ? (stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1) : "?";
          line(gray(`  ${tps} tok/s · ctx ${Math.round(100 * lastCtx / NUM_CTX)}%`));
        }
        return;
      }
      for (let k = 0; k < calls.length; k++) {
        const call = calls[k];
        const name = call.function?.name; let args = call.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        if (stopFlag) { add({ role: "tool", tool_name: name, content: "Skipped: the user interrupted." }); continue; }
        const t = TOOLS[name];
        const label = toolLabel(name, args, (p) => show(P(p)));
        line(`${green("⏺")} ${bold(label)}`);
        live?.emit("tool", { name, label });
        let result;
        try { result = t ? await t.run(args) : `Unknown tool ${name}. Tools: ${Object.keys(TOOLS).join(", ")}`; }
        catch (e) { result = `Tool error: ${e.message}`; }
        const sum = toolSummary(name, result);
        line(gray("  ⎿  ") + (sum.bad ? red(sum.text) : gray(sum.text)));
        for (const l of sum.more || []) line(gray(`     ${l}`));
        live?.emit("tool_result", { name, summary: sum.text, bad: !!sum.bad, detail: String(result).slice(0, 4000) });
        add({ role: "tool", tool_name: name, content: String(result) });
      }
      if (stopFlag) { line(gray("  ⎿  Interrupted. What should Cleetus do instead?")); live?.emit("notice", { text: "Interrupted" }); return; }
    }
    note(`stopped after ${MAX_STEPS} steps; say "continue" to keep going`, true);
  } finally {
    busy = false; stopFlag = false;
    live?.setState("idle");
  }
}

// ---------- spinner ----------
const spinner = (() => {
  let iv = null, t0 = 0, i = 0, verb = "", extraText = "";
  return {
    start(v) {
      if (!tty || iv) return;
      verb = v || pickVerb(); t0 = Date.now(); extraText = "";
      iv = setInterval(() => out(`\r${spinnerFrame(i++, verb, Math.round((Date.now() - t0) / 1000), extraText)}\x1b[K`), 120);
    },
    extra(s) { extraText = s; },
    stop() { if (iv) { clearInterval(iv); iv = null; out("\r\x1b[K"); } },
  };
})();

// ---------- sessions ----------
const sessionDir = join(STATE, "sessions");
let sessionKey = CWD.replaceAll("/", "_");
async function loadLast() {
  try {
    const files = (await readdir(sessionDir)).filter((f) => f.startsWith(sessionKey + "__") && f.endsWith(".json")).sort();
    if (!files.length) return null;
    const f = join(sessionDir, files.at(-1));
    return { file: f, messages: JSON.parse(await readFile(f, "utf8")) };
  } catch { return null; }
}
let sessionFile = null;
let saving = Promise.resolve();
// Atomic: a crash mid-write leaves the previous version, never half a file.
function save(ms = messages) {
  const snapshot = JSON.stringify(ms);
  saving = saving.then(async () => {
    await mkdir(sessionDir, { recursive: true });
    sessionFile ??= join(sessionDir, `${sessionKey}__${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const tmp = `${sessionFile}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot);
    await rename(tmp, sessionFile);
    if (live && live.sessionFile !== sessionFile) { live.sessionFile = sessionFile; live.writeMeta(); }
  }).catch((e) => crashLog("save", e));
  return saving;
}
let saveTimer = null;
function persistSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), 250); }
async function archive(ms) {
  const dir = join(sessionDir, "archive");
  await mkdir(dir, { recursive: true });
  const f = join(dir, `${sessionKey}__${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(f, JSON.stringify(ms));
  return f;
}

// ---------- staying alive ----------
function crashLog(where, e) {
  const msg = `${new Date().toISOString()} [${process.pid}] ${where}: ${e?.stack || e}\n`;
  appendFile(join(STATE, "crash.log"), msg).catch(() => {});
}
let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  interrupt();
  spinner.stop();
  clearTimeout(saveTimer);
  if (messages.length > 1) await save().catch(() => {});
  await live?.close(reason).catch(() => {});
  if (tty && messages.length > 1) line(gray(`\n  Session saved. Resume it with ${bold("cleetus -c")}${ORIGIN === "phone" ? "" : " here"}, or from your phone.`));
  process.exit(code);
}
for (const sig of ["SIGHUP", "SIGTERM"]) process.on(sig, () => shutdown(sig === "SIGHUP" ? "terminal closed" : "terminated"));
process.on("uncaughtException", (e) => {
  crashLog("uncaught", e);
  if (e?.code === "EPIPE") return shutdown("terminal gone");
  try { line(red(`  internal error: ${e?.message || e} (logged to ~/.cleetus/crash.log; the session is saved and still running)`)); } catch {}
  persistSoon();
});
process.on("unhandledRejection", (e) => {
  crashLog("unhandled", e);
  try { line(red(`  internal error: ${e?.message || e} (logged to ~/.cleetus/crash.log; the session is saved and still running)`)); } catch {}
});
process.stdout.on("error", (e) => { if (e.code === "EPIPE") shutdown("terminal gone"); });

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

const problem = await checkModel();
if (problem) { console.error(red(`cleetus: ${problem}`)); process.exit(1); }

messages = [{ role: "system", content: systemPrompt() }];
let resumed = 0;
if (RESUME || CONTINUE) {
  let prev = null;
  if (RESUME) {
    const f = resolve(RESUME.startsWith("/") ? RESUME : join(sessionDir, RESUME));
    if (!f.startsWith(sessionDir + "/") || !existsSync(f)) { console.error(red(`cleetus: no saved session ${RESUME}`)); process.exit(1); }
    prev = { file: f, messages: JSON.parse(await readFile(f, "utf8")) };
  } else prev = await loadLast();
  if (prev) {
    messages = [{ role: "system", content: systemPrompt() }, ...prev.messages.filter((m) => m.role !== "system")];
    sessionFile = prev.file;       // keep writing the same file instead of forking a copy per resume
    resumed = prev.messages.length;
  }
}

if (oneShot !== null) {
  add({ role: "user", content: oneShot || (await readFile("/dev/stdin", "utf8")) });
  busy = true;
  try { await turn(messages); } catch (e) { console.error(red(`cleetus: ${e.message}`)); }
  await save(); process.exit(0);
}

// Live: the phone's way in. A session that cannot register still works locally.
try {
  const firstUser = messages.find((m) => m.role === "user" && !String(m.content).startsWith("[Session summary"));
  live = new LiveSession({ cwd: CWD, model: MODEL, sessionFile, origin: ORIGIN, launch: LAUNCH, title: firstUser ? String(firstUser.content).slice(0, 80) : "" });
  await live.start();
  if (resumed) {
    const items = [];
    for (const m of messages.slice(1)) {
      if (m.role === "user") items.push({ role: "user", text: String(m.content).slice(0, 3000) });
      else if (m.role === "assistant" && String(m.content).trim()) items.push({ role: "assistant", text: String(m.content).slice(0, 3000) });
      else if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) {
        let a = c.function?.arguments || {};
        if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
        items.push({ role: "tool", text: toolLabel(c.function?.name, a, (p) => show(P(p))) });
      }
    }
    live.emit("history", { items: items.slice(-80), total: items.length });
  }
  live.onInterrupt = () => { if (busy) { interrupt(); } };
  live.onStop = () => shutdown("stopped from phone");
} catch (e) { crashLog("live", e); live = null; }

// ---------- input ----------
// One queue for everything the session is asked: lines typed here and messages
// from the phone. Approvals take the next typed line directly (lineWaiter).
const inputs = [];
let wake = null;
let lineWaiter = null;
let promptShown = false;
function enqueue(item) { inputs.push(item); wake?.(); }
if (live) live.onInbox = () => wake?.();

rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive, historySize: 500,
  completer: (l) => [[], l] });   // a completer turns tab and shift+tab into no-ops instead of inserting them
if (interactive) {
  const orig = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted) orig(s); };
}
rl.on("line", (l) => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); return; }
  if (!l.trim()) { if (promptShown) redrawPrompt(); return; }
  enqueue({ text: l, from: "terminal" });
  if (!promptShown && tty) line(gray(`  ⎿  queued: ${l.slice(0, 70)}`));
});
rl.on("close", () => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(null); }
  // Piped stdin closing is not a reason to end a session the phone is driving.
  if (interactive || !live) shutdown("input closed");
});

function readLine(prompt) {
  return new Promise((res) => {
    lineWaiter = res; muted = false;
    rl.setPrompt(prompt); rl.prompt();
  });
}
function cancelLine() {
  lineWaiter = null;
  rl.line = ""; rl.cursor = 0;
  out("\r\x1b[K");
}

const ctxPct = () => Math.round(100 * Math.max(lastCtx, estTokens(messages) + Math.ceil(JSON.stringify(toolSchemas).length / 3.2)) / NUM_CTX);
const status = () => statusLine({ mode: MODE, model: MODEL, ctxPct: ctxPct(), cwd: tilde(CWD), liveId: live?.id, width: cols() });
// The input box. readline clears everything below the prompt whenever it
// redraws, so the bottom border and the status line are drawn AFTER it, again
// after every keypress (see the keypress listener), with the cursor saved and
// restored around them. Space is reserved first so the bottom of the screen
// never scrolls between the save and the restore.
function drawPrompt() {
  promptShown = true; muted = false;
  if (!interactive) return;
  out(`\n${gray("╭" + "─".repeat(cols() - 2) + "╮")}\n\n\n\n\x1b[3A\r`);
  rl.setPrompt(gray("│ ") + "> ");
  rl.prompt(true);
  drawBottom();
}
function drawBottom() {
  if (!interactive || !promptShown || lineWaiter) return;
  const w = process.stdout.columns || 80;
  const len = 4 + vis(rl.line || "");
  const down = Math.floor(len / w) - Math.floor((4 + (rl.cursor || 0)) / w) + 1;
  out(`\x1b7\x1b[${down}B\r\x1b[K${gray("╰" + "─".repeat(cols() - 2) + "╯")}\x1b[1B\r\x1b[K${status()}\x1b8`);
}
function redrawPrompt() { if (!interactive) return; out("\x1b[1A\r\x1b[J"); promptShown = false; drawPrompt(); }
function setStatus(text) {
  if (!interactive || !promptShown || lineWaiter) return;
  const w = process.stdout.columns || 80;
  const down = Math.floor((4 + vis(rl.line || "")) / w) - Math.floor((4 + (rl.cursor || 0)) / w) + 2;
  out(`\x1b7\x1b[${down}B\r\x1b[K${text}\x1b8`);
}
function clearPrompt(item) {
  promptShown = false;
  if (!interactive) { if (item.from === "phone") line(`> ${item.text}  (from phone)`); return; }
  if (item.from === "terminal") {
    const rows = Math.max(1, Math.ceil((4 + vis(item.text)) / (process.stdout.columns || 80)));
    out(`\x1b[${rows + 1}A\r\x1b[J`);
  } else {
    rl.line = ""; rl.cursor = 0;
    out("\r\x1b[1A\x1b[J");
  }
  const first = item.text.split("\n")[0];
  const shown = first.length > cols() - 8 ? first.slice(0, cols() - 9) + "…" : first;
  line(onGray(` > ${shown} `) + (item.from === "phone" ? gray("  from your phone") : ""));
  line("");
  muted = true;
}
async function nextInput() {
  for (;;) {
    if (live?.inbox.length) { const text = live.inbox.shift(); live.writeMeta(); return { text, from: "phone" }; }
    if (inputs.length) return inputs.shift();
    if (!promptShown) drawPrompt();
    await new Promise((res) => { wake = res; });
    wake = null;
  }
}

let lastSigint = 0;
rl.on("SIGINT", () => {
  if (busy) { interrupt(); return; }
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w("n"); return; }
  if (rl.line) { rl.line = ""; rl.cursor = 0; redrawPrompt(); return; }
  if (Date.now() - lastSigint < 1500) return shutdown("exit");
  lastSigint = Date.now();
  setStatus(yellow("  Press Ctrl-C again to exit"));
  setTimeout(() => setStatus(status()), 1500);
});
if (interactive) {
  process.stdin.on("keypress", (_s, key) => {
    if (!key) return;
    if (key.name === "escape" && busy) interrupt();
    if (key.name === "tab" && key.shift && promptShown && !lineWaiter) {
      MODE = MODES[(MODES.indexOf(MODE) + 1) % MODES.length];
    }
    // readline has just redrawn (and cleared below) for this key; put the box back.
    if (promptShown && !busy && !lineWaiter && !(key.name === "return" || key.name === "enter")) drawBottom();
  });
}

// ---------- commands ----------
const HELP = `  ${bold("Commands")}
  /compact       summarize older messages now to free context (automatic at 80%)
  /context       how full the context window is
  /phone         how to reach this session from your phone
  /mode [m]      ask | edits | yolo (or shift+tab)
  /clear         start a fresh conversation (the old one stays on disk)
  /model [name]  show or switch the Ollama model
  /think         toggle showing reasoning (currently ${THINK ? "on" : "off"})
  /cwd [dir]     show or change the working directory
  /exit          save and quit (Ctrl-C twice does the same)

  ${bold("Keys")}  esc interrupts · shift+tab cycles approval mode · type while it works to queue a message`;

async function command(q) {
  const [cmd, ...rest] = q.slice(1).split(/\s+/); const arg = rest.join(" ");
  if (cmd === "exit" || cmd === "quit") return shutdown("exit");
  if (cmd === "help") return line(HELP);
  if (cmd === "compact") { busy = true; try { await keepInWindow(messages, { force: true }); } finally { busy = false; } return save(); }
  if (cmd === "context") return note(`~${Math.round(ctxPct() * NUM_CTX / 100)} of ${NUM_CTX} tokens (${ctxPct()}%), ${messages.length} messages; compacts at ${Math.round(SUMMARIZE_AT * 100)}%`);
  if (cmd === "phone") return note(live ? `live as ${live.id}: open cleetusai.com/code on your phone (it is in the Cleetus app too)` : "this session could not register for the phone; see ~/.cleetus/crash.log");
  if (cmd === "mode" || cmd === "yolo") {
    MODE = cmd === "yolo" ? (MODE === "yolo" ? "ask" : "yolo") : (MODES.includes(arg) ? arg : MODES[(MODES.indexOf(MODE) + 1) % MODES.length]);
    return note(`mode: ${MODE}${MODE === "edits" ? " (edits apply without asking; shell still asks)" : MODE === "yolo" ? " (nothing asks)" : " (everything asks)"}`);
  }
  if (cmd === "clear") {
    await save();
    messages = [{ role: "system", content: systemPrompt() }]; sessionFile = null;
    if (live) { live.title = ""; live.emit("notice", { text: "conversation cleared (the old one is saved)" }); live.writeMeta(); }
    return note("cleared; the old conversation is saved and can be resumed with --resume");
  }
  if (cmd === "think") { THINK = !THINK; return note(`reasoning ${THINK ? "shown" : "off"}`); }
  if (cmd === "model") {
    if (arg) { const old = MODEL; MODEL = arg; const p = await checkModel(); if (p) { note(p, true); MODEL = old; } else { messages[0].content = systemPrompt(); if (live) { live.model = MODEL; live.writeMeta(); } note(`model: ${MODEL}`); } }
    else note(MODEL);
    return;
  }
  if (cmd === "cwd") {
    if (arg) { const d = P(arg); if (existsSync(d) && statSync(d).isDirectory()) { CWD = d; process.chdir(d); sessionKey = CWD.replaceAll("/", "_"); messages[0].content = systemPrompt(); if (live) { live.cwd = CWD; live.writeMeta(); } } else return note("not a directory", true); }
    return note(tilde(CWD));
  }
  note(`unknown command ${cmd}; /help`, true);
}

// ---------- welcome ----------
if (tty) {
  const w = Math.min(cols(), 76);
  line(box([
    `${amber("✻")} ${bold("Welcome to Cleetus Code")}`,
    "",
    gray(`  /help for commands · esc to interrupt · shift+tab for modes`),
    gray(`  cwd: ${tilde(CWD)}`),
    gray(`  ${MODEL} · local · ${Math.round(NUM_CTX / 1024)}k context, compacts itself`),
    live ? gray(`  phone: cleetusai.com/code · session ${live.id}`) : gray("  phone: unavailable (see ~/.cleetus/crash.log)"),
    ...(resumed ? [gray(`  resumed ${resumed} messages from ${basename(sessionFile)}`)] : []),
  ], { width: w, color: amber }));
  if (MODE === "yolo") line(yellow("  yolo: nothing asks before writing or running"));
}

// ---------- the loop ----------
for (;;) {
  const item = await nextInput();
  clearPrompt(item);
  const text = item.text.trim();
  if (text.startsWith("/") && !text.includes("\n") && /^\/[a-z]+(\s|$)/.test(text)) {
    try { await command(text); } catch (e) { note(`error: ${e.message}`, true); }
    continue;
  }
  if (live) {
    live.last_input_from = item.from;
    if (!live.title) live.title = text.slice(0, 80);
    live.emit("user", { text, from: item.from });
  }
  add({ role: "user", content: text });
  try { await turn(messages); }
  catch (e) { crashLog("turn", e); note(`error: ${e.message}`, true); }
  await save();
}
