// src/facegate.mjs: money needs a face.
//
// Grayson asked (2026-09-15) that Cleetus check it is actually him at the desk
// before touching money: Schwab balances, the ledger, Books, snapshots. The
// pipeline already existed (YuNet + SFace in face_cli.py, the C920 through
// AirPad's /frame.jpg); this only makes a tool call depend on it.
//
// WHAT IT PROVES AND WHAT IT DOES NOT. Three frames are read over about a
// second and at least two of them must contain a face that SFace scores as
// Grayson at 0.45 or better (the shipped 0.363 let a lookalike through; see
// project_cleetus_face_recognition). There is no liveness test: a photograph
// or a phone video of him held to the camera will pass. That is the same
// standard as a badge on a lanyard: it stops the wrong person at the desk,
// not a determined impostor with his picture. Do not describe it as more.
//
// A pass is a SESSION, not a one-off: it holds for FACE_GATE_TTL_S (10 min
// default) so a conversation about money is not three camera checks a
// minute. A fail is never cached; the next money call looks again.
//
// THE REFUSAL IS A SENTENCE THE MODEL READS. The tool result is what it
// answers from, so the denial says, in the result itself, that nothing was
// fetched and that money figures must not be produced from memory. A bare
// "denied" would be filled in with plausible numbers.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { CONFIG } from "./config.mjs";

const run = promisify(execFile);
const env = process.env;

export const FACE_GATE = {
  enabled: (env.FACE_GATE_MONEY ?? "1") !== "0",
  name: env.FACE_GATE_NAME || "Grayson",
  ttlMs: Number(env.FACE_GATE_TTL_S || 600) * 1000,
  frames: Number(env.FACE_GATE_FRAMES || 3),
  needed: Number(env.FACE_GATE_NEEDED || 2),
  // "reliable" in face_cli means the face is >= 100 px tall, close enough to
  // the lens that the embedding is trustworthy. Off by default because the
  // C920 looks across the room; turn on if the camera ever moves to the desk.
  strict: env.FACE_GATE_STRICT === "1",
  cameraUrl: env.FACE_GATE_CAMERA_URL || "http://127.0.0.1:8768/frame.jpg",
  python: env.CLEETUSD_PYTHON || `${CONFIG.home}/studio-locate/.venv/bin/python`,
  cli: `${CONFIG.home}/cleetusd/face_cli.py`,
};

// What counts as money. cloud_api is the one tool that reaches the ledger, and
// it takes a path; these are the paths. Anything else the model might route
// money through in future goes in MONEY_TOOLS by name.
const MONEY_PATH = /^\/?api\/(schwab|ledger|books|snapshots|plaid|simplefin|bank|money|accounts|invoices|bills|payroll|tax)(\/|\?|$)/i;
const MONEY_TOOLS = new Set(String(env.FACE_GATE_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean));

export function isMoneyCall(name, args) {
  if (MONEY_TOOLS.has(name)) return true;
  if (name === "cloud_api") return MONEY_PATH.test(String(args?.path || ""));
  return false;
}

// ── State ──
let session = { until: 0, at: 0, scores: [] };     // the current pass, if any
let last = null;                                   // the last check, pass or fail
let inflight = null;                               // one camera check at a time

export function status() {
  const now = Date.now();
  return {
    enabled: FACE_GATE.enabled,
    name: FACE_GATE.name,
    authorized: session.until > now,
    expires_in_s: session.until > now ? Math.round((session.until - now) / 1000) : 0,
    last,
  };
}

/** Forget the current pass. For "lock it" and for tests. */
export function revoke() {
  session = { until: 0, at: 0, scores: [] };
}

async function identifyOnce() {
  try {
    const { stdout } = await run(FACE_GATE.python,
      [FACE_GATE.cli, "identify", "--url", FACE_GATE.cameraUrl], { timeout: 12_000 });
    return JSON.parse(stdout);
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    return { ok: false, error: "unreachable", detail: e.message };
  }
}

/**
 * Look, FACE_GATE.frames times, and decide. Returns {ok, reason, scores}.
 * Frames are spaced so they are different pictures, not the same frame read
 * three times. AirPad serves a new frame ~24 times a second, so 350 ms apart
 * is comfortably distinct.
 */
async function check() {
  if (!existsSync(FACE_GATE.python)) return { ok: false, reason: `no Python with OpenCV at ${FACE_GATE.python}` };
  if (!existsSync(FACE_GATE.cli)) return { ok: false, reason: `face_cli.py missing at ${FACE_GATE.cli}` };
  const scores = [];
  let hits = 0, seenAnyone = false, cameraErr = null;
  for (let i = 0; i < FACE_GATE.frames; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350));
    const r = await identifyOnce();
    if (!r.ok) { cameraErr = `${r.error}${r.detail ? ": " + r.detail : ""}`; continue; }
    const faces = r.faces || [];
    if (faces.length) seenAnyone = true;
    const me = faces.find((f) => f.name === FACE_GATE.name && (!FACE_GATE.strict || f.reliable));
    scores.push(me ? me.score : (faces[0]?.score ?? null));
    if (me) hits++;
  }
  if (hits >= FACE_GATE.needed) return { ok: true, reason: `${FACE_GATE.name} seen in ${hits}/${FACE_GATE.frames} frames`, scores };
  if (cameraErr && !seenAnyone && hits === 0) {
    return { ok: false, reason: `the room camera could not be read (${cameraErr}). AirPad serves that frame; if it is not running, neither is the face check`, scores };
  }
  if (!seenAnyone) return { ok: false, reason: "no face in view of the room camera", scores };
  return { ok: false, reason: `a face was in view but it was not confirmed as ${FACE_GATE.name} (${hits}/${FACE_GATE.frames} frames matched at threshold 0.45)`, scores };
}

/**
 * The gate. Returns null when the call may proceed, or the refusal text the
 * tool result should be.
 */
export async function guard(name, args) {
  if (!FACE_GATE.enabled || !isMoneyCall(name, args)) return null;
  const now = Date.now();
  if (session.until > now) return null;

  // Coalesce: two money tools in the same turn should share one look.
  if (!inflight) inflight = check().finally(() => { inflight = null; });
  const r = await inflight;
  last = { at: new Date().toISOString(), ok: r.ok, reason: r.reason, scores: r.scores || [] };
  if (r.ok) {
    session = { until: now + FACE_GATE.ttlMs, at: now, scores: r.scores || [] };
    console.log(`[facegate] pass: ${r.reason}; money unlocked for ${Math.round(FACE_GATE.ttlMs / 60000)} min`);
    return null;
  }
  console.log(`[facegate] REFUSED ${name}: ${r.reason}`);
  return (
    `MONEY ACCESS REFUSED: ${name} was NOT called and nothing was fetched. ` +
    `Reason: ${r.reason}. ` +
    `This tool touches financial data and needs ${FACE_GATE.name}'s face confirmed at the room camera first. ` +
    `Tell him plainly that the face check did not pass and why, ask him to look toward the C920 and try again. ` +
    `Do NOT produce balances, totals, transactions or any money figure from memory or from earlier in this conversation.`
  );
}
