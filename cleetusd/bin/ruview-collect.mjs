#!/usr/bin/env node
// bin/ruview-collect.mjs — build a labelled dataset out of the room.
//
// WHY THIS EXISTS. Every attempt to make RuView answer "is Grayson at his desk"
// has thresholded ONE feature — motion_energy first (AUC 0.47), then
// motion_band_power (AUC 0.60). A single-feature threshold is the weakest
// possible classifier, and its failure does not prove the information is
// absent. It proves that ONE projection of the signal does not carry it.
//
// What changed is that there is now a trustworthy LABEL. com.cleetus.desk-trigger
// reports desk presence from HID idle time — a direct measurement of a person
// using the desk, not an inference about it. That turns this from a threshold
// hunt into a supervised learning problem, which is the right shape for it.
//
// So: sample every feature the sensing server emits, once a second, and stamp
// each sample with the label. Then a model can be fitted over ALL of them
// together and cross-validated. If a fitted model still cannot separate at-desk
// from away, that is a real answer about the hardware rather than an answer
// about my choice of threshold.
//
// THE LABEL IS IMPERFECT AND THAT IS RECORDED, NOT HIDDEN. HID idle means
// "hands on the keyboard recently", so a person sitting and reading is labelled
// away while physically present. idle_seconds is kept on every row so a fit can
// exclude the ambiguous middle (say 60-600 s) instead of learning from it.

import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const OUT_DIR = join(HOME, "cleetusd", "roomwatch");
const OUT = join(OUT_DIR, "ruview-labeled.jsonl");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const WS_URL = process.env.RUVIEW_WS || "ws://127.0.0.1:3001/ws/sensing";
const DESK = join(HOME, "desk-trigger", "state.json");

let latest = null;

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.type === "sensing_update") latest = m;
    } catch { /* a malformed frame is not a reason to drop the stream */ }
  };
  ws.onclose = () => setTimeout(connect, 3000);
  ws.onerror = () => { try { ws.close(); } catch {} };
}
connect();

function deskState() {
  try {
    const d = JSON.parse(readFileSync(DESK, "utf8"));
    return { at_desk: Boolean(d.at_desk), idle: Number(d.idle_seconds), locked: Boolean(d.locked) };
  } catch { return null; }
}

/** Every numeric the server publishes per node, flattened. */
function row(msg, desk) {
  const out = { t: Date.now() / 1000, at_desk: desk.at_desk, idle: desk.idle, locked: desk.locked, n: {} };
  for (const nf of msg.node_features || []) {
    const f = nf.features || {};
    out.n[nf.node_id] = {
      mbp: f.motion_band_power ?? null,
      bbp: f.breathing_band_power ?? null,
      var: f.variance ?? null,
      spec: f.spectral_power ?? null,
      dom: f.dominant_freq_hz ?? null,
      chg: f.change_points ?? null,
      rssi: nf.rssi_dbm ?? null,
      stale: Boolean(nf.stale),
    };
  }
  const rf = msg.features || {};
  out.room = {
    mbp: rf.motion_band_power ?? null, bbp: rf.breathing_band_power ?? null,
    var: rf.variance ?? null, spec: rf.spectral_power ?? null, dom: rf.dominant_freq_hz ?? null,
    chg: rf.change_points ?? null,
  };
  return out;
}

// A 1 Hz writer left running is ~43 MB/day. That is fine for a few days and is
// how a disk quietly fills over a month, so it stops itself rather than relying
// on someone remembering it exists. 200 MB is about four days, far more than
// the question needs.
const CAP_BYTES = 200 * 1024 * 1024;
let capped = false;

let written = 0;
setInterval(() => {
  if (capped) return;
  try {
    if (existsSync(OUT) && statSync(OUT).size > CAP_BYTES) {
      capped = true;
      console.error(`reached the ${CAP_BYTES / 1024 / 1024} MB cap — stopping. Analyse or move the file, then restart the agent.`);
      return;
    }
  } catch { /* a stat failure is not a reason to stop collecting */ }
  const desk = deskState();
  if (!latest || !desk) return;
  // Only rows where all three boards are contributing — a sample taken while a
  // board is down is a measurement of the outage, not of the room.
  const nodes = latest.node_features || [];
  if (nodes.length < 3 || nodes.some((n) => n.stale)) return;
  appendFileSync(OUT, JSON.stringify(row(latest, desk)) + "\n");
  if (++written % 300 === 0) console.error(`${new Date().toISOString()} ${written} rows`);
}, 1000);

console.error(`collecting -> ${OUT}`);
