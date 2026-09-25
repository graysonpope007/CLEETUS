// src/coderoutes.mjs: /code/*, the phone's window onto `cleetus` coding sessions.
//
//   GET  /code/sessions                     live sessions + recently saved ones
//   POST /code/sessions {cwd, text?, resume?}  start one (in tmux, so the Mac can attach too)
//   GET  /code/sessions/:id?after=N         meta + events after seq N
//   POST /code/sessions/:id/message {text}
//   POST /code/sessions/:id/approve {aid, decision: y|n|a}
//   POST /code/sessions/:id/interrupt
//   POST /code/sessions/:id/stop
//   GET  /code/dirs                         where a new session can start
//
// Behind the daemon's bearer gate like everything else that writes; the web app
// adds the token in functions/api/code/[[path]].js so the phone never holds it.
// Sessions themselves own their conversations (src/codelive.mjs); this file only
// lists, reads and forwards.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, statSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { CONFIG } from "./config.mjs";
import { listLive, readMeta, readEvents, sessionCall, newId, ID_RE } from "./codelive.mjs";

const run = promisify(execFile);
const HOME = CONFIG.home;
const SESSIONS = join(HOME, ".cleetus", "sessions");
const CLI = join(HOME, "cleetusd", "bin", "cleetus.mjs");
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync);
const PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** Saved conversations, newest first, with the directory each one ran in. */
export async function savedSessions(limit = 20) {
  let files = [];
  try { files = (await readdir(SESSIONS)).filter((f) => f.endsWith(".json") && !f.includes(".tmp")); } catch { return []; }
  const withTime = [];
  for (const f of files) { try { withTime.push({ f, m: (await stat(join(SESSIONS, f))).mtimeMs }); } catch {} }
  withTime.sort((a, b) => b.m - a.m);
  const live = await listLive({ includeEnded: false });
  const out = [];
  for (const { f, m } of withTime.slice(0, limit)) {
    try {
      const msgs = JSON.parse(await readFile(join(SESSIONS, f), "utf8"));
      const sys = String(msgs[0]?.content || "");
      const cwd = /Working directory: (.+)/.exec(sys)?.[1]?.trim() || null;
      const users = msgs.filter((x) => x.role === "user" && !String(x.content).startsWith("[Session summary"));
      const lastText = [...msgs].reverse().find((x) => x.role === "assistant" && String(x.content).trim());
      const file = join(SESSIONS, f);
      // Only what can actually be resumed: a folder that still exists, inside HOME.
      if (!cwd || !safeDir(cwd)) continue;
      out.push({
        file: f, cwd, updated_at: new Date(m).toISOString(), messages: msgs.length,
        title: users[0] ? String(users[0].content).slice(0, 90) : "(empty)",
        last: lastText ? String(lastText.content).slice(0, 160) : "",
        live_id: live.find((s) => s.session_file === file)?.id || null,
      });
    } catch {}
  }
  return out;
}

/** A directory a phone may start a session in: exists, is a directory, lives under HOME. */
function safeDir(input) {
  let p = String(input || "").trim();
  if (!p) return null;
  if (p.startsWith("~")) p = join(HOME, p.slice(1));
  p = resolve(p);
  try {
    const real = realpathSync(p);
    if (!(real === HOME || real.startsWith(HOME + "/"))) return null;
    return statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

export async function startSession({ cwd, text, resume }) {
  if (!TMUX) return { ok: false, error: "tmux is not installed" };
  const dir = safeDir(cwd || HOME);
  if (!dir) return { ok: false, error: "cwd must be an existing directory inside your home folder" };
  let resumeFile = null;
  if (resume) {
    if (!/^[\w.-]+\.json$/.test(resume) || !existsSync(join(SESSIONS, resume))) return { ok: false, error: "no such saved session" };
    resumeFile = join(SESSIONS, resume);
    const already = (await listLive({ includeEnded: false })).find((s) => s.session_file === resumeFile);
    if (already) return { ok: true, id: already.id, already_running: true };
  }
  const launch = newId();
  const name = `cleetus-${launch}`;
  await run(TMUX, ["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", dir,
    "env", `PATH=${PATH}`, `HOME=${HOME}`, process.execPath, CLI, "--origin", "phone", "--launch", launch,
    ...(resumeFile ? ["--resume", resumeFile] : [])], { timeout: 10000 });
  // The session registers once Ollama has answered its model check.
  const t0 = Date.now();
  let meta = null;
  while (Date.now() - t0 < 25000) {
    meta = (await listLive({ includeEnded: false })).find((s) => s.launch === launch && s.state === "idle");
    if (meta) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!meta) {
    let screen = "";
    try { screen = (await run(TMUX, ["capture-pane", "-pt", name], { timeout: 5000 })).stdout.trim().split("\n").slice(-6).join("\n"); } catch {}
    return { ok: false, error: "the session did not start in 25s", tmux: name, screen };
  }
  if (text && String(text).trim()) await sessionCall(meta.id, "POST", "/message", { text: String(text) });
  return { ok: true, id: meta.id, tmux: name, cwd: dir };
}

/** Returns true if it answered the request. */
export async function handleCode(req, res, url, { json, readBody }) {
  const p = url.pathname;
  if (!p.startsWith("/code/")) return false;

  if (p === "/code/sessions" && req.method === "GET") {
    const [live, saved] = await Promise.all([listLive({ limit: 30 }), savedSessions(20)]);
    json(res, { ok: true, sessions: live, saved });
    return true;
  }
  if (p === "/code/sessions" && req.method === "POST") {
    const b = await readBody(req);
    const r = await startSession(b).catch((e) => ({ ok: false, error: e.message }));
    json(res, r, r.ok ? 200 : 400);
    return true;
  }
  if (p === "/code/dirs" && req.method === "GET") {
    const dirs = new Set([HOME, join(HOME, "cleetusd"), join(HOME, "cleetusv2")]);
    try {
      const { repoIndex } = await import("./repos.mjs");
      const idx = await repoIndex();
      for (const r of idx.repos || idx.local || []) { const d = r.path || r.dir; if (d) dirs.add(d); }
    } catch {}
    const recent = (await savedSessions(30)).map((s) => s.cwd).filter(Boolean);
    const list = [...new Set([...recent, ...dirs])].filter((d) => safeDir(d)).slice(0, 60);
    json(res, { ok: true, dirs: list.map((d) => ({ path: d, label: d.replace(HOME, "~") })) });
    return true;
  }

  const m = /^\/code\/sessions\/([a-z0-9]{6,16})(?:\/(message|approve|interrupt|stop))?$/.exec(p);
  if (!m || !ID_RE.test(m[1])) { json(res, { ok: false, error: "not_found" }, 404); return true; }
  const [, id, action] = m;
  if (!action && req.method === "GET") {
    const meta = await readMeta(id);
    if (!meta) { json(res, { ok: false, error: "no_such_session" }, 404); return true; }
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    const ev = await readEvents(id, { after });
    json(res, { ok: true, meta, ...ev });
    return true;
  }
  if (action && req.method === "POST") {
    const b = action === "interrupt" || action === "stop" ? null : await readBody(req);
    const r = await sessionCall(id, "POST", `/${action}`, b);
    json(res, r, r.ok ? 200 : r.error === "session_not_running" ? 410 : 400);
    return true;
  }
  json(res, { ok: false, error: "method_not_allowed" }, 405);
  return true;
}

// ---------------------------------------------------------------------------
// Pushes: tell the phone when a session it is driving needs it.
// Only for sessions the phone started or last spoke to; a session Grayson is
// typing into at the desk does not buzz his pocket.
// ---------------------------------------------------------------------------
const seen = new Map();   // id -> { state, aid }
export function startCodeWatcher({ intervalMs = 4000, push } = {}) {
  const send = async (title, body, data) => {
    const r = await push?.(title, body, data).catch((e) => ({ ok: false, why: e.message }));
    console.error(`[code] push "${title}" -> ${r?.ok ? "sent" : `NOT sent: ${r?.why || JSON.stringify(r)}`}`);
  };
  const tick = async () => {
    let live = [];
    try { live = await listLive({ includeEnded: false }); } catch { return; }
    for (const s of live) {
      const prev = seen.get(s.id) || { state: s.state, aid: null };
      const remote = s.origin === "phone" || s.last_input_from === "phone";
      const where = basename(s.cwd || "") || "~";
      try {
        if (remote && s.state === "awaiting_approval" && s.pending?.aid && s.pending.aid !== prev.aid) {
          const first = String(s.pending.preview || "").split("\n").find((l) => l.trim() && !/^(Edit|Create|Overwrite|Run a shell)/.test(l.trim())) || "";
          await send(`Cleetus needs your OK · ${where}`, `${s.pending.kind === "edits" ? "Edit" : "Run"}: ${first.trim().slice(0, 140)}`, { data: { view: "code", session: s.id } });
          prev.aid = s.pending.aid;
        }
        if (remote && prev.state === "working" && s.state === "idle") {
          const { events } = await readEvents(s.id, { after: Math.max(0, s.seq - 40) });
          const last = [...events].reverse().find((e) => e.type === "assistant");
          await send(`Cleetus finished · ${where}`, (last?.text || "Done.").replace(/\s+/g, " ").slice(0, 170), { data: { view: "code", session: s.id } });
        }
      } catch {}
      prev.state = s.state;
      seen.set(s.id, prev);
    }
  };
  const iv = setInterval(tick, intervalMs);
  iv.unref?.();
  return () => clearInterval(iv);
}
