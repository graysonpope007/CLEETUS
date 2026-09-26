// test/cleetus-live.test.mjs: a real `cleetus` process, a fake Ollama, and the
// phone's side of the protocol (src/codelive.mjs). Nothing here touches the real
// ~/.cleetus: HOME points at a temp dir for both the CLI and this test.
//
// What it proves, end to end:
//   - a message sent from the phone runs a turn
//   - an approval can be answered from the phone (yes and no both honoured)
//   - Ollama answering 503 is retried, not fatal
//   - every message is on disk before the turn finishes (kill -9 mid-turn loses nothing)
//   - /stop ends the session cleanly; a killed one shows as "dropped"

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "cleetus-live-"));
process.env.HOME = HOME;
const { listLive, readEvents, sessionCall, readMeta } = await import("../src/codelive.mjs");
const CLI = new URL("../bin/cleetus.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a scripted Ollama ──
let script = [];            // each entry: (body) => ({ status?, delayMs?, message })
let chatCalls = 0;
const ollama = createServer(async (req, res) => {
  let body = ""; for await (const d of req) body += d;
  if (req.url === "/api/show") { res.writeHead(200); return res.end(JSON.stringify({ capabilities: ["completion", "tools"] })); }
  if (req.url === "/api/chat") {
    chatCalls++;
    const step = script.shift() || (() => ({ message: { role: "assistant", content: "ok" } }));
    const r = step(JSON.parse(body));
    if (r.delayMs) await sleep(r.delayMs);
    if (r.status) { res.writeHead(r.status); return res.end("busy"); }
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    if (r.message.content) res.write(JSON.stringify({ message: { role: "assistant", content: r.message.content } }) + "\n");
    return res.end(JSON.stringify({ message: { role: "assistant", content: "", ...(r.message.tool_calls ? { tool_calls: r.message.tool_calls } : {}) }, done: true, prompt_eval_count: 100, eval_count: 10 }) + "\n");
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
const OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;

function startCli(cwd) {
  const ch = spawn(process.execPath, [CLI], { cwd, env: { ...process.env, HOME, OLLAMA_HOST, CLEETUS_CTX: "8192" }, stdio: ["pipe", "pipe", "pipe"] });
  let log = ""; ch.stdout.on("data", (d) => (log += d)); ch.stderr.on("data", (d) => (log += d));
  ch.log = () => log;
  return ch;
}
async function until(fn, ms = 15000, what = "condition") {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(100); }
}
const bash = (command) => () => ({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "bash", arguments: { command } } }] } });
const say = (content) => () => ({ message: { role: "assistant", content } });

test("the phone drives a session: message, approval yes and no, Ollama retry, stop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cleetus-proj-"));
  const cli = startCli(cwd);
  try {
    const meta = await until(async () => (await listLive()).find((m) => m.pid === cli.pid && m.state === "idle"), 15000, "session to register");
    assert.equal(realpathSync(meta.cwd), realpathSync(cwd));

    // 1. A 503 first (retried), then a shell command that needs approval, then a final answer.
    script = [() => ({ status: 503 }), bash("echo hello > made.txt"), say("Made the file.")];
    const sent = await sessionCall(meta.id, "POST", "/message", { text: "make a file" });
    assert.equal(sent.ok, true);

    const ask = await until(async () => (await readEvents(meta.id)).events.find((e) => e.type === "approval"), 20000, "an approval");
    assert.match(ask.preview, /echo hello > made\.txt/);
    assert.equal((await readMeta(meta.id)).state, "awaiting_approval");
    assert.equal((await sessionCall(meta.id, "POST", "/approve", { aid: ask.aid, decision: "y" })).ok, true);
    // Answering twice is refused rather than applied twice.
    assert.equal((await sessionCall(meta.id, "POST", "/approve", { aid: ask.aid, decision: "n" })).ok, false);

    await until(async () => (await readMeta(meta.id)).state === "idle" && (await readEvents(meta.id)).events.some((e) => e.type === "assistant" && /Made the file/.test(e.text)), 20000, "turn to finish");
    assert.equal(readFileSync(join(cwd, "made.txt"), "utf8").trim(), "hello");
    const ev = (await readEvents(meta.id)).events;
    assert.ok(ev.some((e) => e.type === "user" && e.from === "phone" && e.text === "make a file"));
    assert.ok(ev.some((e) => e.type === "notice" && /retrying/.test(e.text)), "the 503 was retried and said so");
    assert.ok(ev.some((e) => e.type === "tool" && e.label === "Bash(echo hello > made.txt)"));
    assert.ok(ev.some((e) => e.type === "tool_result" && e.summary.startsWith("exit 0")));
    assert.ok(ev.some((e) => e.type === "approval_done" && e.by === "phone" && e.decision === "y"));

    // 2. Declined from the phone: the command must not run.
    script = [bash("echo nope > nope.txt"), say("Okay, I will not.")];
    await sessionCall(meta.id, "POST", "/message", { text: "make another" });
    const ask2 = await until(async () => (await readEvents(meta.id)).events.find((e) => e.type === "approval" && e.aid !== ask.aid), 20000, "second approval");
    await sessionCall(meta.id, "POST", "/approve", { aid: ask2.aid, decision: "n" });
    await until(async () => (await readEvents(meta.id)).events.some((e) => e.type === "assistant" && /will not/.test(e.text)), 20000, "declined turn to finish");
    assert.equal(existsSync(join(cwd, "nope.txt")), false);

    // 2b. Interrupt while parked on an approval: the command must not run, the session must come back.
    script = [bash("echo parked > parked.txt"), say("Stopped.")];
    await sessionCall(meta.id, "POST", "/message", { text: "park on an approval" });
    const ask3 = await until(async () => (await readEvents(meta.id)).events.find((e) => e.type === "approval" && ![ask.aid, ask2.aid].includes(e.aid)), 20000, "third approval");
    await sessionCall(meta.id, "POST", "/interrupt");
    await until(async () => (await readEvents(meta.id)).events.some((e) => e.type === "approval_done" && e.aid === ask3.aid && e.decision === "n"), 10000, "interrupt to answer no");
    await until(async () => (await readMeta(meta.id)).state === "idle", 10000, "back to idle");
    assert.equal(existsSync(join(cwd, "parked.txt")), false);

    // 3. The conversation is on disk.
    const sessions = readdirSync(join(HOME, ".cleetus", "sessions")).filter((f) => f.endsWith(".json"));
    assert.equal(sessions.length, 1);
    const saved = JSON.parse(readFileSync(join(HOME, ".cleetus", "sessions", sessions[0]), "utf8"));
    assert.ok(saved.some((m) => m.role === "user" && m.content === "make another"));

    // 4. Stop from the phone.
    await sessionCall(meta.id, "POST", "/stop");
    await until(() => cli.exitCode !== null, 10000, "process to exit");
    const end = await readMeta(meta.id);
    assert.equal(end.state, "ended");
    assert.equal(existsSync(join(HOME, ".cleetus", "live", `${meta.id}.sock`)), false);
  } finally {
    if (cli.exitCode === null) cli.kill("SIGKILL");
  }
});

test("a session killed mid-turn has already saved the message, and shows as dropped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cleetus-proj-"));
  const cli = startCli(cwd);
  const meta = await until(async () => (await listLive()).find((m) => m.pid === cli.pid && m.state === "idle"), 15000, "session");
  script = [() => ({ delayMs: 8000, message: { role: "assistant", content: "too late" } })];
  await sessionCall(meta.id, "POST", "/message", { text: "remember this even if I crash" });
  await until(async () => (await readMeta(meta.id)).state === "working", 10000, "working");
  await sleep(700);
  cli.kill("SIGKILL");
  await until(() => cli.exitCode !== null || cli.signalCode, 5000, "kill");
  const file = await until(() => (readMeta(meta.id).then((m) => m?.session_file)), 5000, "session file named");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(saved.some((m) => m.role === "user" && m.content === "remember this even if I crash"));
  assert.equal((await readMeta(meta.id)).state, "dropped");
});

test("-c resumes the same file and replays history for the phone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cleetus-proj-"));
  mkdirSync(join(HOME, ".cleetus", "sessions"), { recursive: true });
  const first = startCli(cwd);
  const m1 = await until(async () => (await listLive()).find((m) => m.pid === first.pid && m.state === "idle"), 15000, "first");
  script = [say("first answer")];
  await sessionCall(m1.id, "POST", "/message", { text: "first question" });
  await until(async () => (await readEvents(m1.id)).events.some((e) => e.type === "assistant"), 15000, "answer");
  await sessionCall(m1.id, "POST", "/stop");
  await until(() => first.exitCode !== null, 10000, "exit");
  const file1 = (await readMeta(m1.id)).session_file;

  const second = spawn(process.execPath, [CLI, "-c"], { cwd, env: { ...process.env, HOME, OLLAMA_HOST }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const m2 = await until(async () => (await listLive()).find((m) => m.pid === second.pid && m.state === "idle"), 15000, "second");
    assert.equal(m2.session_file, file1, "resuming writes back to the same file, not a copy");
    const hist = (await readEvents(m2.id)).events.find((e) => e.type === "history");
    assert.ok(hist.items.some((i) => i.role === "user" && i.text === "first question"));
    assert.ok(hist.items.some((i) => i.role === "assistant" && i.text === "first answer"));
  } finally { second.kill("SIGKILL"); }
});

test.after(() => ollama.close());
