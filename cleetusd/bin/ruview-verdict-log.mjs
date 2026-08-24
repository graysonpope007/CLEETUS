#!/usr/bin/env node
// ruview-verdict-log.mjs: sample the signals RuView PRESENTS AS ANSWERS, so
// their error rate can be measured against verified ground truth.
//
// ruview-collect.mjs records the raw per-node features, which is what a model
// would train on. This records the OUTPUTS a human or a dashboard would believe:
// person_count, motion_level, presence, and the pose endpoint's person list.
// Those have never been measured against a room somebody confirmed was empty,
// only against HID idle time, which cannot tell an empty room from a person
// reading in it.
//
// Capped, because it is meant to be left running.
import { appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OUT = join(homedir(), "cleetusd", "roomwatch", "ruview-verdicts.jsonl");
const BASE = "http://127.0.0.1:3000/api/v1";
const EVERY_MS = 5000;
const CAP_BYTES = 40 * 1024 * 1024;

const get = async (p) => {
  try {
    const r = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

async function sample() {
  const [nodes, vitals, pose] = await Promise.all([
    get("/nodes"), get("/edge-vitals"), get("/pose/current"),
  ]);
  const ns = (nodes?.nodes || []).sort((a, b) => a.node_id - b.node_id);
  const ev = vitals?.edge_vitals || {};
  const persons = pose?.persons || pose?.poses || [];

  return {
    t: Date.now() / 1000,
    // Per node, the two fields a dashboard renders as an answer.
    nodes: Object.fromEntries(ns.map((n) => [n.node_id, {
      pc: n.person_count, ml: n.motion_level, rssi: n.rssi_dbm, st: n.status,
      seen: n.last_seen_ms,
    }])),
    // edge-vitals reports ONE node per call (whichever answered), so node_id
    // matters: without it these numbers cannot be attributed.
    ev: { node: ev.node_id, presence: ev.presence, score: ev.presence_score,
          motion: ev.motion, energy: ev.motion_energy, n_persons: ev.n_persons,
          br: ev.breathing_rate_bpm, hr: ev.heartrate_bpm },
    // Pose fabricates; record enough to prove it rather than assert it.
    pose: {
      n: persons.length,
      pos: persons.slice(0, 6).map((p) => p.position || p.center || null),
      maxkp: persons.length
        ? Math.max(...persons.flatMap((p) => (p.keypoints || []).map((k) => k.confidence ?? 0)), 0)
        : null,
    },
  };
}

console.error(`sampling verdicts every ${EVERY_MS / 1000}s -> ${OUT}`);
let stop = false;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { stop = true; });

while (!stop) {
  try {
    if (existsSync(OUT) && statSync(OUT).size > CAP_BYTES) renameSync(OUT, OUT + ".1");
    appendFileSync(OUT, JSON.stringify(await sample()) + "\n");
  } catch (e) { console.error("sample failed:", e.message); }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
