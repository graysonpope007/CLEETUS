// src/codelive.mjs — live coding sessions, shared by bin/cleetus.mjs and the daemon.
//
// Every `cleetus` coding session (typed in a terminal, or started from the phone)
// registers itself in ~/.cleetus/live/:
//
//   <id>.json    who it is: pid, cwd, model, state, the saved-session file
//   <id>.jsonl   what happened, one event per line, numbered (seq)
//   <id>.sock    a unix socket it listens on for messages, approvals, interrupt, stop
//
// The daemon never talks to the model for a session. It lists these files, reads
// the event log for the phone, and forwards the phone's input to the socket. The
// session process stays the single owner of its conversation, so a terminal and
// a phone looking at the same session can never disagree about it: whoever
// answers an approval first wins, and both see the answer.
//
// The socket is mode 600 inside ~/.cleetus, so only this user can drive it; the
// only way in from outside the machine is the daemon's bearer-gated /code routes.

import { mkdir, writeFile, readFile, readdir, appendFile, rename, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, request } from "node:http";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const LIVE = join(homedir(), ".cleetus", "live");
export const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[78]/g, "");
export const newId = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
export const ID_RE = /^[a-z0-9]{6,16}$/;

// macOS caps a unix socket path at 104 bytes. ~/.cleetus/live/<id>.sock fits for
// any normal home; a long HOME (tests, odd setups) falls back to /tmp, still
// inside a directory only this user can enter.
function sockPath(id) {
  const p = join(LIVE, `${id}.sock`);
  return Buffer.byteLength(p) < 100 ? p : join("/tmp", `cleetus-${process.getuid?.() ?? "u"}`, `${id}.sock`);
}
const paths = (id) => ({ meta: join(LIVE, `${id}.json`), events: join(LIVE, `${id}.jsonl`), sock: sockPath(id) });

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((res) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > limit) req.destroy(); });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { res({}); } });
    req.on("error", () => res({}));
  });
}

/** One session's end of the protocol. Lives inside the cleetus process. */
export class LiveSession {
  constructor({ id = newId(), cwd, model, sessionFile = null, origin = "terminal", launch = null, title = "" }) {
    Object.assign(this, { id, cwd, model, sessionFile, origin, launch, title });
    this.p = paths(id);
    this.seq = 0;
    this.state = "starting";
    this.started_at = new Date().toISOString();
    this.last_input_from = origin === "phone" ? "phone" : "terminal";
    this.pending = null;            // { aid, kind, preview }
    this.inbox = [];                // messages from the phone, in order
    this.onInbox = null;            // set by the owner: called when a message arrives
    this.onInterrupt = null;
    this.onStop = null;
    this.approvalResolvers = new Map();
    this.writeChain = Promise.resolve();
    this.server = null;
  }

  meta() {
    return {
      id: this.id, pid: process.pid, cwd: this.cwd, model: this.model, origin: this.origin,
      launch: this.launch, title: this.title, state: this.state, pending: this.pending,
      last_input_from: this.last_input_from, session_file: this.sessionFile,
      started_at: this.started_at, updated_at: new Date().toISOString(), seq: this.seq,
      queued: this.inbox.length,
    };
  }

  async start() {
    await mkdir(LIVE, { recursive: true });
    await mkdir(dirname(this.p.sock), { recursive: true, mode: 0o700 });
    if (existsSync(this.p.sock)) await unlink(this.p.sock).catch(() => {});
    this.server = createServer((req, res) => this.route(req, res).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message }));
    }));
    await new Promise((res, rej) => { this.server.once("error", rej); this.server.listen(this.p.sock, res); });
    await chmod(this.p.sock, 0o600).catch(() => {});
    this.state = "idle";
    await this.writeMeta();
  }

  /** Queue a write so meta and events land in the order they happened. */
  queue(fn) { this.writeChain = this.writeChain.then(fn).catch(() => {}); return this.writeChain; }
  writeMeta() { const m = JSON.stringify(this.meta()); return this.queue(() => writeAtomic(this.p.meta, m)); }
  emit(type, data = {}) {
    const ev = { seq: ++this.seq, t: Date.now(), type, ...data };
    this.queue(() => appendFile(this.p.events, JSON.stringify(ev) + "\n"));
    return ev;
  }
  setState(state, extra = {}) {
    if (this.state === state && !Object.keys(extra).length) return;
    Object.assign(this, extra);
    this.state = state;
    this.emit("status", { state });
    this.writeMeta();
  }

  /** Ask the phone too. Resolves with "y" | "n" | "a" if the phone answers first. */
  requestApproval(kind, preview) {
    const aid = newId();
    this.pending = { aid, kind, preview: stripAnsi(preview).slice(0, 12000) };
    this.emit("approval", this.pending);
    this.setState("awaiting_approval");
    const promise = new Promise((res) => this.approvalResolvers.set(aid, res));
    return { aid, promise };
  }
  settleApproval(aid, decision, by) {
    const r = this.approvalResolvers.get(aid);
    if (!r) return false;
    this.approvalResolvers.delete(aid);
    this.pending = null;
    this.emit("approval_done", { aid, decision, by });
    this.setState("working");
    r(decision);
    return true;
  }

  async route(req, res) {
    const send = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, "http://session");
    if (req.method === "GET" && url.pathname === "/state") return send({ ok: true, ...this.meta() });
    if (req.method !== "POST") return send({ ok: false, error: "method_not_allowed" }, 405);
    const b = await readJsonBody(req);
    if (url.pathname === "/message") {
      const text = String(b.text ?? "").trim();
      if (!text) return send({ ok: false, error: "empty" }, 400);
      this.inbox.push(text.slice(0, 20000));
      this.writeMeta();
      this.onInbox?.();
      return send({ ok: true, queued: this.state !== "idle" });
    }
    if (url.pathname === "/approve") {
      const d = ["y", "n", "a"].includes(b.decision) ? b.decision : null;
      if (!d) return send({ ok: false, error: "decision must be y, n or a" }, 400);
      const ok = this.settleApproval(String(b.aid || ""), d, "phone");
      return send(ok ? { ok: true } : { ok: false, error: "no such pending approval (already answered?)" }, ok ? 200 : 409);
    }
    if (url.pathname === "/interrupt") { this.onInterrupt?.(); return send({ ok: true }); }
    if (url.pathname === "/stop") { send({ ok: true }); setTimeout(() => this.onStop?.(), 50); return; }
    return send({ ok: false, error: "not_found" }, 404);
  }

  async close(reason = "ended") {
    for (const [aid] of this.approvalResolvers) this.settleApproval(aid, "n", "shutdown");
    this.state = "ended";
    this.ended_reason = reason;
    this.emit("status", { state: "ended", reason });
    await this.writeMeta();
    await this.writeChain;
    await new Promise((res) => (this.server ? this.server.close(() => res()) : res()));
    await unlink(this.p.sock).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The daemon's side
// ---------------------------------------------------------------------------

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Every registered session, newest first. A dead pid that never said goodbye is "dropped". */
export async function listLive({ includeEnded = true, limit = 40 } = {}) {
  let files = [];
  try { files = (await readdir(LIVE)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(await readFile(join(LIVE, f), "utf8"));
      if (m.state !== "ended" && !alive(m.pid)) m.state = "dropped";
      m.alive = m.state !== "ended" && m.state !== "dropped";
      if (!includeEnded && !m.alive) continue;
      out.push(m);
    } catch {}
  }
  out.sort((a, b) => (b.alive - a.alive) || String(b.updated_at).localeCompare(String(a.updated_at)));
  return out.slice(0, limit);
}

export async function readMeta(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const m = JSON.parse(await readFile(paths(id).meta, "utf8"));
    if (m.state !== "ended" && !alive(m.pid)) m.state = "dropped";
    m.alive = m.state !== "ended" && m.state !== "dropped";
    return m;
  } catch { return null; }
}

/** Events after `after`, capped. The first read of a long session starts at its tail. */
export async function readEvents(id, { after = 0, limit = 400 } = {}) {
  if (!ID_RE.test(id)) return { events: [], last: 0 };
  let text = "";
  try { text = await readFile(paths(id).events, "utf8"); } catch { return { events: [], last: 0 }; }
  const all = [];
  for (const line of text.split("\n")) { if (!line) continue; try { all.push(JSON.parse(line)); } catch {} }
  const last = all.length ? all.at(-1).seq : 0;
  let events = all.filter((e) => e.seq > after);
  let truncated = false;
  if (events.length > limit) {
    // Keep the history snapshot so a late viewer still sees how the session began.
    const history = after === 0 ? events.filter((e) => e.type === "history").slice(-1) : [];
    events = [...history, ...events.slice(-limit)];
    truncated = true;
  }
  return { events, last, truncated };
}

/** Talk to a session's socket. */
export function sessionCall(id, method, path, body = null, { timeoutMs = 8000 } = {}) {
  return new Promise((res) => {
    if (!ID_RE.test(id)) return res({ ok: false, error: "bad_id" });
    const data = body ? JSON.stringify(body) : null;
    const req = request({ socketPath: paths(id).sock, method, path,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (r) => {
      let s = ""; r.on("data", (d) => (s += d));
      r.on("end", () => { try { res(JSON.parse(s)); } catch { res({ ok: false, error: `bad reply (${r.statusCode})` }); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => res({ ok: false, error: e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "session_not_running" : e.message }));
    if (data) req.write(data);
    req.end();
  });
}
