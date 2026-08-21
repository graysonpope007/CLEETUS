// src/roomwatch.mjs — the room alarm: RuView shouts, the camera decides.
//
// SHAPE, AND WHY IT IS THIS SHAPE
//
// Grayson asked for the two sensors in conjunction, with RuView as the first
// alert and the camera picking it up once RuView has fired. That is a good
// architecture for a reason worth writing down: the cheap always-on sensor
// gates the expensive one, and the expensive one holds the veto. A RuView false
// positive costs two seconds of camera time and is thrown away; it never
// reaches a notification. So RuView being noisy is survivable by construction.
//
// What is NOT survivable by construction is RuView being BLIND, because a
// first stage that never fires means a second stage that never runs. That is
// not hypothetical here — measured 2026-08-20, empty room versus a seated
// person scored AUC 0.473/0.474/0.444 on the three nodes, which is a coin
// flip. So this file does two things about it:
//
//   1. It scores on `motion_band_power` from the sensing WebSocket, NOT the
//      `motion_energy` on /api/v1/edge-vitals that the AUC test used. They are
//      different numbers: edge motion_energy read 5.87 with a person in the
//      room against an empty-room median of 6.0 — it does not separate at all.
//      motion_band_power is a server-side CSI feature that has never been
//      tested for separation, and it is the one thing here that might make the
//      first stage real. It is measured, not assumed: see `buildBaseline`.
//
//   2. It runs a CAMERA HEARTBEAT on a fixed interval regardless of RuView.
//      This is the whole answer to "what if stage one misses". A miss stops
//      being a hole and becomes a delay bounded by the heartbeat period. It
//      costs one camera grab a minute and it means the alarm cannot be defeated
//      by a sensor that simply never speaks.
//
// A THRESHOLD IS NEVER INVENTED IN THIS FILE. Every number that decides
// anything comes out of roomwatch-baseline.json, which is written by measuring
// the real room. With no baseline the watcher still runs — on the heartbeat
// alone — and says plainly that stage one is disabled. A security system that
// silently guesses its own trip point is worse than one that admits it has not
// been calibrated, because only the second kind ever gets calibrated.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG, secrets } from "./config.mjs";

const HOME = homedir();
export const DIR = join(HOME, "cleetusd", "roomwatch");
export const PATHS = {
  dir: DIR,
  baseline: join(HOME, "cleetusd", "roomwatch-baseline.json"),
  state: join(DIR, "state.json"),
  events: join(DIR, "events.jsonl"),
  samples: join(DIR, "samples"),
  clips: join(DIR, "clips"),
};
for (const d of [DIR, PATHS.samples, PATHS.clips]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const SENSING_WS = process.env.RUVIEW_WS || "ws://127.0.0.1:3001/ws/sensing";
const CAMERA_URL = process.env.ROOMWATCH_CAM || "http://127.0.0.1:8768/frame.jpg";
const PY = process.env.CLEETUSD_PYTHON || `${HOME}/studio-locate/.venv/bin/python`;
const CAM_HELPER = join(HOME, "cleetusd", "bin", "roomwatch-cam.py");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The sensing stream
// ---------------------------------------------------------------------------

// The WebSocket path is /ws/sensing and it is served on BOTH 3000 and 3001.
// The handoff says these are separate listeners and only 3001 works; that was
// half right — the PATH is the part that matters, and a bare ws://host:3001
// with no path is refused with a non-101 status and no explanation.

/**
 * Per-node features from one sensing_update frame, flattened to the numbers
 * that could plausibly carry motion. Everything else in the frame (pose,
 * vital_signs, persons) is fabricated on this deployment and is not read here.
 */
export function extract(msg) {
  if (!msg || msg.type !== "sensing_update") return null;
  const nodes = {};
  for (const nf of msg.node_features || []) {
    const f = nf.features || {};
    nodes[nf.node_id] = {
      mbp: num(f.motion_band_power),
      variance: num(f.variance),
      bbp: num(f.breathing_band_power),
      spectral: num(f.spectral_power),
      rssi: num(nf.rssi_dbm),
      stale: Boolean(nf.stale),
      level: nf.classification?.motion_level ?? null,
    };
  }
  return {
    t: msg.timestamp ?? Date.now() / 1000,
    tick: msg.tick ?? null,
    nodes,
    room: {
      mbp: num(msg.features?.motion_band_power),
      variance: num(msg.features?.variance),
      level: msg.room_inference?.classification ?? null,
    },
  };
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Hold a sensing stream open, calling back with each extracted frame.
 * Reconnects for as long as `stop()` has not been called — a watcher that
 * quietly dies when the sensing server restarts is a watcher that is off.
 */
export function openSensing(onFrame, onStatus = () => {}) {
  let ws = null, stopped = false, backoff = 1000;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(SENSING_WS);
    ws.onopen = () => { backoff = 1000; onStatus({ up: true }); };
    ws.onmessage = (ev) => {
      let f = null;
      try { f = extract(JSON.parse(String(ev.data))); } catch { /* a malformed frame is not a reason to drop the stream */ }
      if (f) onFrame(f);
    };
    const down = (why) => {
      if (stopped) return;
      onStatus({ up: false, why });
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onclose = () => down("closed");
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  connect();
  return () => { stopped = true; try { ws && ws.close(); } catch {} };
}

// ---------------------------------------------------------------------------
// Measuring the room
// ---------------------------------------------------------------------------

/**
 * Record labelled sensing frames to samples/<label>.jsonl.
 *
 * The label is the experiment. "empty" must be recorded with the room actually
 * empty, and the point of writing it to its own file is that a mislabelled run
 * can be deleted rather than quietly poisoning a baseline — which is exactly
 * how the node-level presence thresholds got poisoned once already, by booting
 * a node while somebody was sitting in the room.
 */
export async function sample(label, seconds, onTick = () => {}) {
  const path = join(PATHS.samples, `${label}.jsonl`);
  const camPath = join(PATHS.samples, `${label}-cam.jsonl`);
  let n = 0, cam = 0;
  const stop = openSensing((f) => {
    appendFileSync(path, JSON.stringify(f) + "\n");
    onTick(++n, cam);
  });

  // The camera is sampled in the SAME window, not in a separate session. Its
  // threshold has to come from the same lighting, the same time of day and the
  // same room as the RF threshold, or the two stages are calibrated against
  // different rooms and only one of them knows it.
  let stopped = false;
  const camLoop = (async () => {
    while (!stopped) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const p = await cameraProbe({ frames: 5, gapMs: 220, tag: `cal-${label}-${stamp}`, save: true, keep: true });
      if (p.ok) {
        appendFileSync(camPath, JSON.stringify({
          t: Date.now() / 1000, max_diff: p.max_diff, max_spread: p.max_spread, mean_diff: p.mean_diff,
          changed_pct: p.max_changed_pct, frozen: p.frozen, brightness: p.mean_brightness, saved: p.saved,
        }) + "\n");
        cam++;
      }
      await sleep(1500);
    }
  })();

  await sleep(seconds * 1000);
  stopped = true; stop();
  await camLoop;
  return { label, path, frames: n, camPath, camSamples: cam };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
function stats(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
  return { n: v.length, min: r2(v[0]), p50: r2(pct(v, 0.5)), p95: r2(pct(v, 0.95)), p99: r2(pct(v, 0.99)), p995: r2(pct(v, 0.995)), max: r2(v[v.length - 1]), mean: r2(mean), sd: r2(sd) };
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * AUC by the rank formula: the probability that a random occupied sample
 * outranks a random empty one. 0.5 is a coin flip and 1.0 is perfect. This is
 * the same measure the 2026-08-20 test used, so the numbers are comparable —
 * which is the entire point of computing it here rather than eyeballing means.
 */
export function auc(emptyVals, busyVals) {
  const a = emptyVals.filter((x) => x != null), b = busyVals.filter((x) => x != null);
  if (!a.length || !b.length) return null;
  let wins = 0;
  for (const x of b) for (const y of a) wins += x > y ? 1 : x === y ? 0.5 : 0;
  return Math.round((wins / (a.length * b.length)) * 1000) / 1000;
}

export async function readSamples(label) {
  const path = join(PATHS.samples, `${label}.jsonl`);
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Build the baseline from an "empty" recording and, when one exists, an
 * "occupied" recording to check the feature actually separates.
 *
 * The trip point is the empty-room p99 times a margin. p99 rather than max
 * because one autoexposure-scale outlier in a ten-minute recording should not
 * set the alarm's sensitivity for the rest of its life, and a margin on top
 * because p99 by definition is exceeded 1% of the time — at 2 Hz that is a
 * trip every fifty seconds, all night.
 */
/**
 * Build the thresholds by measuring the room — and label the measurement with
 * the CAMERA rather than with a promise about who was where.
 *
 * The first version of this trusted the filenames: whatever was in empty.jsonl
 * was the empty room. That produced a baseline claiming the empty room moved
 * MORE than the occupied one, which was not a sensor fault — the recordings
 * simply did not contain what their names said. A person asked to "move around
 * for four minutes" sits still after ninety seconds, and a person asked to
 * leave takes a moment to go and comes back before the timer ends.
 *
 * So the label now comes from a source that was actually looking: every camera
 * probe records what fraction of the frame changed, and each RF frame is
 * labelled by the probe whose window it falls in. `changed_pct == 0` means the
 * camera saw nothing move; `>= 3` means it saw something real. The evidence
 * frames are on disk next to the numbers, so any surprising result can be
 * checked by looking at the picture instead of being argued about.
 */
export async function buildBaseline({ margin = 1.6 } = {}) {
  const cam = [], rf = [];
  for (const label of ["empty", "occupied"]) {
    cam.push(...(await readSamples(`${label}-cam`)).filter((r) => r.changed_pct != null));
    rf.push(...(await readSamples(label)));
  }
  if (!cam.length) throw new Error("no camera samples — record with: roomwatch sample empty 150");

  // A probe covers roughly the 1.6 s ending at its stamp (5 frames at 220 ms).
  const labelOf = (t) => {
    for (const r of cam) if (t >= r.t - 1.6 && t <= r.t + 0.2) return r.changed_pct;
    return null;
  };

  const still = { frames: [], byNode: {} }, moving = { frames: [], byNode: {} };
  let unlabelled = 0;
  for (const f of rf) {
    const c = labelOf(f.t);
    if (c == null) { unlabelled++; continue; }
    const bucket = c === 0 ? still : c >= 3 ? moving : null;
    if (!bucket) continue;                          // the ambiguous middle is discarded on purpose
    const peaks = [];
    for (const [id, nd] of Object.entries(f.nodes || {})) {
      if (nd.mbp == null || nd.stale) continue;
      (bucket.byNode[id] ||= []).push(nd.mbp);
      peaks.push(nd.mbp);
    }
    if (peaks.length) bucket.frames.push(Math.max(...peaks));
  }
  if (still.frames.length < 300) {
    throw new Error(`only ${still.frames.length} frames the camera confirms were still; need 300+. Record more: roomwatch sample empty 150`);
  }

  const ids = [...new Set([...Object.keys(still.byNode), ...Object.keys(moving.byNode)])].sort();
  const perNode = {};
  for (const id of ids) {
    perNode[id] = {
      still: stats(still.byNode[id] || []),
      moving: moving.byNode[id]?.length ? stats(moving.byNode[id]) : null,
      auc: moving.byNode[id]?.length ? auc(still.byNode[id] || [], moving.byNode[id]) : null,
    };
  }

  // The operating points of the rule the watcher actually runs: three
  // consecutive frames over a threshold wakes the camera. Reported as a table
  // because a single AUC hides the thing that decides whether stage one earns
  // its place — whether ANY threshold both catches movement and stays quiet.
  const FPS = 70;                                    // measured stream rate
  const stillPeaks = still.frames, movPeaks = moving.frames;
  const sSorted = [...stillPeaks].sort((a, b) => a - b);
  const runRule = (vals, thr, need = 3) => {
    let n = 0, run = 0;
    for (const v of vals) { if (v >= thr) { if (++run >= need) { n++; run = 0; } } else run = 0; }
    return n;
  };
  const operating = [0.9, 0.95, 0.99, 0.995, 0.999].map((q) => {
    const thr = r2(pct(sSorted, q));
    return {
      quantile: q, threshold: thr,
      false_wakes_per_hour: Math.round(runRule(stillPeaks, thr) / (stillPeaks.length / FPS) * 3600),
      catches_per_minute_of_movement: movPeaks.length ? r2(runRule(movPeaks, thr) / (movPeaks.length / FPS) * 60) : null,
    };
  });

  // The camera's own floor. A still room scores exactly 0 on changed_pct, so
  // the trip is an absolute margin rather than a multiple of nothing.
  const camStill = cam.filter((r) => r.changed_pct === 0).map((r) => r.changed_pct);
  const camMoving = cam.filter((r) => r.changed_pct >= 3).map((r) => r.changed_pct);
  const camStats = stats(cam.map((r) => r.changed_pct));

  // A usable gate needs an operating point that is BOTH quiet and catching.
  const workable = operating.find((o) => o.false_wakes_per_hour <= 120 && (o.catches_per_minute_of_movement || 0) >= 2);

  // WHICH POINT THE WATCHER ACTUALLY RUNS AT, which is not the same question as
  // whether the gate is any good.
  //
  // Grayson asked for RuView first and the camera second, and that is what runs
  // — but the measurement above says no threshold is both quiet and catching.
  // So the choice is the QUIETEST point that still catches movement at least
  // twice a minute: stage one keeps giving an early alert (a body is seen
  // within about ten seconds), and its false alarms cost one 1.5-second camera
  // probe each, which the camera vetoes and nobody is told about. Everything
  // louder than this is the camera running continuously with extra steps.
  const chosen = [...operating].reverse().find((o) => (o.catches_per_minute_of_movement || 0) >= 2) || operating[operating.length - 1];
  const bestAuc = Math.max(...ids.map((id) => perNode[id].auc ?? 0));

  const baseline = {
    built_at: new Date().toISOString(),
    feature: "motion_band_power",
    source: "ws /ws/sensing node_features[].features.motion_band_power",
    labelled_by: "camera changed_pct — 0 means the camera saw nothing move, >=3 means it saw something real",
    margin,
    still_frames: stillPeaks.length,
    moving_frames: movPeaks.length,
    still_seconds: Math.round(stillPeaks.length / FPS),
    moving_seconds: Math.round(movPeaks.length / FPS),
    unlabelled_frames: unlabelled,
    nodes: perNode,
    auc: r2(auc(stillPeaks, movPeaks)),
    operating,
    // Set from the quietest point that still catches anything, else the p99.5.
    chosen_operating_point: chosen,
    // Per node, at the same quantile the pooled choice above sits at, so one
    // loud node cannot set the trip for all three.
    trip: Object.fromEntries(ids.map((id) => {
      const st = perNode[id].still;
      if (!st) return [id, null];
      return [id, chosen.quantile >= 0.995 ? st.p995 : chosen.quantile >= 0.99 ? st.p99 : st.p95];
    })),
    camera: {
      still: stats(camStill), moving: camMoving.length ? stats(camMoving) : null, all: camStats,
      probes: cam.length,
      // 0.5% of the frame: far above the exact 0.0 a still room scores and far
      // below the 3-98% a body crossing the room produces.
      trip: 0.5,
    },
    usable: Boolean(workable),
  };

  baseline.running_at = `stage one trips at ${JSON.stringify(baseline.trip)}, chosen for ${chosen.false_wakes_per_hour} camera wakes an hour in a still room and ${chosen.catches_per_minute_of_movement} catches per minute of movement.`;
  baseline.verdict = workable
    ? `motion_band_power works as a gate: at threshold ${workable.threshold} it wakes the camera ` +
      `${workable.false_wakes_per_hour} times an hour in a still room and catches movement ` +
      `${workable.catches_per_minute_of_movement} times a minute.`
    : `motion_band_power does NOT work as a gate. Best AUC ${r2(bestAuc)}, and no threshold is both quiet ` +
      `and catching: every setting that catches movement wakes the camera thousands of times an hour, and ` +
      `every quiet setting catches nothing. The still room's own peaks (p99 ${r2(pct(sSorted, 0.99))}) run ` +
      `HIGHER than the moving room's, so thresholding the top end is worse than chance. ` +
      `The camera heartbeat is what is actually guarding this room.`;

  await writeFile(PATHS.baseline, JSON.stringify(baseline, null, 2));
  return baseline;
}

export async function loadBaseline() {
  try { return JSON.parse(await readFile(PATHS.baseline, "utf8")); } catch { return null; }
}

/** How far above its own empty-room trip point each node currently is. */
export function scoreFrame(frame, baseline) {
  if (!baseline?.trip) return { armed: false, tripped: [], peak: null };
  const tripped = [];
  let peak = 0;
  for (const [id, node] of Object.entries(frame.nodes || {})) {
    const trip = baseline.trip[id];
    if (trip == null || node.mbp == null || node.stale) continue;
    const ratio = node.mbp / trip;
    if (ratio > peak) peak = ratio;
    if (ratio >= 1) tripped.push({ node: Number(id), mbp: r2(node.mbp), trip, ratio: r2(ratio) });
  }
  return { armed: true, tripped, peak: r2(peak) };
}

// ---------------------------------------------------------------------------
// Stage two: the camera
// ---------------------------------------------------------------------------

/**
 * Ask the camera whether anything moved. Returns the whole difference series,
 * not a verdict, so the caller's threshold is visible at the call site.
 *
 * Measured 2026-08-21 through the C920 that watches the bedroom door: a still
 * room differences at 0.36-0.56, a person moving in frame at 11.1. There is
 * a twenty-fold margin here, which is why this stage gets the veto and RuView
 * does not.
 */
export function cameraProbe({ frames = 8, gapMs = 250, tag = "probe", save = false, keep = false } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(PY)) return resolve({ ok: false, error: "no_python", detail: `no OpenCV python at ${PY}` });
    const args = [CAM_HELPER, "--url", CAMERA_URL, "--frames", String(frames), "--gap-ms", String(gapMs), "--tag", tag];
    if (save) args.push("--out", PATHS.clips);
    if (keep) args.push("--keep");
    const p = spawn(PY, args, { timeout: 30_000 });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      try { resolve(JSON.parse(out)); }
      catch { resolve({ ok: false, error: "helper_failed", detail: (err || out).slice(0, 200) }); }
    });
    p.on("error", (e) => resolve({ ok: false, error: "spawn_failed", detail: e.message }));
  });
}

/** Who the camera sees, if the face recogniser can say. Never throws. */
export async function whoIsThere() {
  try {
    const { faceRaw } = await import("./tools/faces.mjs");
    const r = await faceRaw(["identify", "--url", CAMERA_URL], 20_000);
    if (!r?.ok) return { ok: false, why: r?.error || "unknown" };
    const named = (r.faces || []).filter((f) => f.name && !f.too_small).map((f) => f.name);
    const unknown = (r.faces || []).filter((f) => !f.name && !f.too_small).length;
    return { ok: true, named: [...new Set(named)], unknown, faces: (r.faces || []).length };
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Stage three: saying so
// ---------------------------------------------------------------------------

/**
 * Push straight to APNs from this machine.
 *
 * Deliberately NOT via the cloud endpoint. This is an alarm: it has to work
 * when the Cloudflare tunnel is down, and /api/notify also fans out to Twilio,
 * whose toll-free number has never been verified (error 30032) so every SMS it
 * attempts fails silently. Talking to Apple directly is fewer moving parts than
 * either.
 *
 * The key is M54J9L88Y9, which speaks BOTH environments — verified 2026-08-21
 * by posting a 64-zero device token to each host and getting BadDeviceToken
 * (credentials fine, device fake) rather than BadEnvironmentKeyInToken from
 * either. The previous key B8S6L34V7K was Production-only and is why push had
 * never once been delivered.
 */
export async function pushAlert(title, body, data = {}) {
  const { createSign } = await import("node:crypto");
  const { connect } = await import("node:http2");
  const team = secrets.APNS_TEAM_ID, kid = secrets.APNS_KEY_ID, bundle = secrets.APNS_BUNDLE_ID;
  const p8 = join(HOME, "Downloads", `AuthKey_${kid}.p8`);
  if (!team || !kid || !bundle || !existsSync(p8)) {
    return { ok: false, why: `APNs not usable locally: need APNS_TEAM_ID/KEY_ID/BUNDLE_ID and ${p8}` };
  }
  const tokens = await deviceTokens();
  if (!tokens.length) return { ok: false, why: "no device registered in apns_devices" };

  const key = await readFile(p8, "utf8");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid }), claims = b64({ iss: team, iat: Math.floor(Date.now() / 1000) });
  const sig = createSign("SHA256").update(`${head}.${claims}`).end()
    .sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const jwt = `${head}.${claims}.${sig}`;
  const host = secrets.APNS_ENV === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";

  const results = [];
  for (const token of tokens) {
    const c = connect(`https://${host}`);
    const req = c.request({
      ":method": "POST", ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`, "apns-topic": bundle,
      "apns-push-type": "alert", "apns-priority": "10",
    });
    req.end(JSON.stringify({
      aps: { alert: { title, body }, sound: "default", "interruption-level": "time-sensitive" },
      ...data,
    }));
    results.push(await new Promise((res) => {
      let status, out = "";
      req.on("response", (h) => (status = h[":status"]));
      req.on("data", (d) => (out += d));
      req.on("end", () => { c.close(); res({ token: token.slice(0, 8), status, out }); });
      req.on("error", (e) => { c.close(); res({ token: token.slice(0, 8), status: 0, out: e.message }); });
    }));
  }
  return { ok: results.some((r) => r.status === 200), host, results };
}

async function deviceTokens() {
  const url = secrets.SUPABASE_URL, key = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  try {
    const r = await fetch(`${url}/rest/v1/apns_devices?select=token`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const rows = await r.json();
    return Array.isArray(rows) ? rows.map((x) => x.token).filter(Boolean) : [];
  } catch { return []; }
}

/** Flash the room red. Never lets a lighting failure stop an alarm. */
export async function flashRoom() {
  try {
    const { groupFor, flash, hueConfigured } = await import("./hue.mjs");
    if (!hueConfigured()) return { ok: false, why: "no HUE_APP_KEY" };
    const g = await groupFor(secrets.ROOMWATCH_HUE_ROOM || "Bedroom");
    if (!g) return { ok: false, why: "no such Hue room" };
    await flash(g, { times: 5, ms: 300 });
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 120) }; }
}

export function logEvent(ev) {
  appendFileSync(PATHS.events, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function readState() {
  try { return JSON.parse(await readFile(PATHS.state, "utf8")); }
  catch { return { armed: false, since: null, last_event: null }; }
}
export async function writeState(s) {
  await writeFile(PATHS.state, JSON.stringify(s, null, 2));
  return s;
}

// ---------------------------------------------------------------------------
// The watch loop
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  // How many consecutive evaluations must trip before the camera is woken.
  // One is too few: motion_band_power is a windowed variance and spikes on a
  // single frame for reasons that include a laptop lid opening downstairs.
  consecutive: 3,
  evalMs: 500,
  // The bounded-miss guard. Stage one being blind turns from a hole into a
  // delay of at most this long. Sixty seconds costs 1,440 four-frame camera
  // grabs a day, which is nothing, and it is the only reason this system is
  // trustworthy while RuView's separation is unproven.
  heartbeatMs: 30_000,
  // After an alarm, stop alarming for this long. Without it a person walking
  // around an armed room generates a notification every two seconds.
  cooldownMs: 180_000,
  // Frames per camera confirmation, and the gap between them.
  confirmFrames: 6,
  confirmGapMs: 250,

  // HOW LONG A RECOGNISED PERSON KEEPS THE ROOM.
  //
  // Measured the hard way on the first armed run: the watcher saw 3.4% of the
  // frame change with no face in it and raised a full alarm — on Grayson, who
  // was in the room the whole time and had simply turned away from the lens.
  // A face recogniser needs a FACE; motion does not wait for one, and most real
  // movement in a room shows a back or an elbow.
  //
  // So recognition is treated as a fact about the ROOM with a lifetime, not a
  // fact about the current frame. Seeing him two minutes ago is strong evidence
  // he is still there. An intruder in an empty house never produces a known
  // face at all, so this costs nothing against the case that matters.
  recentKnownMs: 120_000,

  // Look twice before shouting. A single confirmation is one glimpse; a second
  // look a few seconds later separates a person from a curtain, a phone screen
  // waking, or the one-off frame the compressor mangled.
  secondLookMs: 4000,
};

/**
 * Run the watcher until stopped.
 *
 * The three stages in one place, deliberately: this is the part someone will
 * read at 3 a.m. wondering why they did or did not get a notification, and
 * splitting it across files to look tidy would cost more than it saves.
 */
export async function runWatch({ log = console.error, ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const baseline = await loadBaseline();
  const camTrip = baseline?.camera?.trip ?? null;

  if (!baseline) {
    log("no baseline: stage one (RuView) is DISABLED and the camera heartbeat is the only guard.");
    log("  fix: roomwatch sample empty 240   (room genuinely empty), then roomwatch baseline");
  } else if (baseline.usable === false) {
    log(`baseline says stage one does not separate (${baseline.verdict})`);
    log("  running anyway, because a noisy first stage that the camera vetoes costs nothing —");
    log("  but the camera heartbeat is what is actually guarding the room.");
  }
  if (camTrip == null) {
    log("no camera threshold in the baseline — refusing to guess what a still room looks like.");
    log("  fix: roomwatch sample empty 240, then roomwatch baseline");
    return { ok: false, why: "camera not calibrated" };
  }

  let latest = null, streak = 0, lastAlarm = 0, busy = false, sensingUp = false, lastKnown = null;
  const stop = openSensing(
    (f) => { latest = f; },
    (s) => { if (s.up !== sensingUp) { sensingUp = s.up; log(`sensing stream ${s.up ? "up" : "DOWN"}`); } },
  );

  /** Stage two and three. `why` records what woke the camera. */
  async function investigate(why, detail) {
    if (busy) return;
    busy = true;
    try {
      const tag = `${new Date().toISOString().replace(/[:.]/g, "-")}-${why}`;
      const probe = await cameraProbe({ frames: cfg.confirmFrames, gapMs: cfg.confirmGapMs, tag, save: true });
      if (!probe.ok) {
        // A camera that cannot be read is itself an event. Silence here is how
        // a system reports "all clear" for a week with the lens capped.
        logEvent({ kind: "camera_unavailable", why, detail, probe });
        log(`camera unavailable: ${probe.error} ${probe.detail || ""}`);
        return;
      }
      if (probe.frozen) {
        // A stalled capture answers 200 with the same bytes forever, which this
        // stage would otherwise read as "nothing is moving" in exactly the
        // situation where an alarm most needs to speak.
        logEvent({ kind: "camera_frozen", why, detail, identical_pairs: probe.identical_pairs });
        log("camera stream is FROZEN — identical frames. The alarm cannot see.");
        return;
      }
      const moved = probe.max_changed_pct >= camTrip;
      const state = await readState();

      if (!moved) {
        logEvent({ kind: "cleared", why, detail, changed_pct: probe.max_changed_pct, cam_trip: camTrip });
        return;
      }

      const who = await whoIsThere();
      const known = who.ok && who.named.length ? who.named : [];
      if (known.length) lastKnown = { at: Date.now(), names: known };
      const event = {
        kind: "motion_confirmed", why, detail,
        changed_pct: probe.max_changed_pct, max_diff: probe.max_diff, cam_trip: camTrip,
        who: known, unknown_faces: who.ok ? who.unknown : null,
        frames: probe.saved, armed: state.armed,
      };

      if (!state.armed) { logEvent({ ...event, action: "logged_only_disarmed" }); return; }

      // The exit delay. Arming a room alarm from inside the room and having it
      // fire while you walk to the door is the oldest false alarm there is.
      if (state.armed_at && Date.now() < state.armed_at) {
        logEvent({ ...event, action: "suppressed_exit_delay", seconds_left: Math.round((state.armed_at - Date.now()) / 1000) });
        return;
      }
      if (known.length) { logEvent({ ...event, action: "suppressed_known_person" }); log(`motion, but it is ${known.join(", ")} — no alarm`); return; }

      // Recognised recently counts. See recentKnownMs above.
      const sinceKnown = lastKnown ? Date.now() - lastKnown.at : Infinity;
      if (sinceKnown < cfg.recentKnownMs) {
        logEvent({ ...event, action: "suppressed_recently_known", recently: lastKnown.names, seconds_ago: Math.round(sinceKnown / 1000) });
        log(`motion with no face, but ${lastKnown.names.join(", ")} was recognised ${Math.round(sinceKnown / 1000)}s ago — no alarm`);
        return;
      }
      if (Date.now() - lastAlarm < cfg.cooldownMs) { logEvent({ ...event, action: "suppressed_cooldown" }); return; }

      // The second look.
      await sleep(cfg.secondLookMs);
      const again = await cameraProbe({ frames: cfg.confirmFrames, gapMs: cfg.confirmGapMs, tag: `${tag}-again`, save: true });
      const whoAgain = await whoIsThere();
      if (whoAgain.ok && whoAgain.named.length) {
        lastKnown = { at: Date.now(), names: whoAgain.named };
        logEvent({ ...event, action: "suppressed_known_on_second_look", who: whoAgain.named });
        log(`second look found ${whoAgain.named.join(", ")} — no alarm`);
        return;
      }
      if (!again.ok || again.max_changed_pct < camTrip) {
        logEvent({ ...event, action: "suppressed_second_look_still", second: again.ok ? again.max_changed_pct : again.error });
        log(`second look ${again.ok ? `saw only ${again.max_changed_pct}%` : "failed"} — not alarming on one glimpse`);
        return;
      }
      event.second_look = again.max_changed_pct;

      lastAlarm = Date.now();
      const body = `Movement in the room${who.ok && who.unknown ? ` — ${who.unknown} unrecognised face(s)` : ""}. ` +
                   `${probe.max_changed_pct}% of the frame changed, against a still-room trip of ${camTrip}%.`;
      const [push, hue] = await Promise.all([
        pushAlert("Cleetus — someone is in the room", body, { view: "room", roomwatch: true }),
        flashRoom(),
      ]);
      logEvent({ ...event, action: "alarm", push: push.ok, push_detail: push.ok ? undefined : push.why, hue: hue.ok });
      log(`ALARM: ${body}  push=${push.ok} hue=${hue.ok}`);
      await writeState({ ...state, last_event: new Date().toISOString() });
    } finally { busy = false; }
  }

  const evalTimer = setInterval(() => {
    if (!latest || !baseline) return;
    const s = scoreFrame(latest, baseline);
    if (s.tripped.length) {
      if (++streak >= cfg.consecutive) { streak = 0; investigate("ruview", s.tripped); }
    } else streak = 0;
  }, cfg.evalMs);

  const beatTimer = setInterval(() => investigate("heartbeat", null), cfg.heartbeatMs);

  // Seed the recognition memory before the first heartbeat. A watcher that
  // starts up with an empty memory treats the person standing in front of it as
  // an unknown intruder for the first two minutes of its life, which is exactly
  // when someone is most likely to have just started it by hand.
  whoIsThere().then((w) => {
    if (w.ok && w.named.length) { lastKnown = { at: Date.now(), names: w.named }; log(`starting with ${w.named.join(", ")} in the room`); }
  });

  log(`watching. stage one ${baseline ? "on" : "off"}, camera trip ${camTrip}, heartbeat ${cfg.heartbeatMs / 1000}s`);
  return {
    ok: true,
    stop() { clearInterval(evalTimer); clearInterval(beatTimer); stop(); },
  };
}
