// src/tools/ruview.mjs — the room, as far as the WiFi can actually see it.
//
// RuView is three ESP32-S3 boards reading WiFi channel state around the studio,
// aggregated by a Rust server on 127.0.0.1:3000. Until now Cleetus had no path
// to any of it: /ruview and the deck tile were pages a human looked at, and if
// you asked him whether anyone was in the studio he had nothing to answer from.
// That is the gap this closes.
//
// WHY THIS TOOL SPENDS MOST OF ITS CODE ON DISTRUST
//
// The sensing server answers every request with confident-looking numbers, and
// a large share of them are manufactured. Measured 2026-08-21:
//
//   /api/v1/pose/current   returns 4-5 people, each confidence 0.90, positions
//                          quantised to 0.6 m, the SAME coordinate repeated up
//                          to four times in one frame, and values outside the
//                          room (x=-3.0 in a room ~2.6 m across).
//   /api/v1/pose/stats     says total_detections: 0 — across 1.3 MILLION frames
//                          processed. The server's own counter has never once
//                          recorded a detection.
//
// Both are true at the same time. That contradiction is the whole basis of the
// gate below, and it is the reason this tool does not simply report what the
// API says: an agent that repeats "five people are in the studio" is not being
// helpful, it is laundering a random number generator through a sentence that
// sounds like observation. Grayson has been burned by exactly this shape before
// — a tool returned a value nobody could source and the answer got invented
// around it — so the rule here is that a number is reported only alongside the
// evidence that it means something.
//
// THE GATE IS COMPUTED, NOT HARDCODED. Every distrust reason below is derived
// from a live field, so the day the sensing is genuinely fixed this tool starts
// trusting it on its own. Writing "vitals are fake" as a constant would mean
// this file quietly lying in the other direction later.
//
// What IS trustworthy here is the fleet itself: whether the boards are powered
// and associated, their frame rates, their link quality, their clock sync. That
// is measured, not inferred, and it is genuinely useful — it answers "are the
// sensors alive" without pretending to answer "is anyone there".

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const BASE = process.env.RUVIEW_URL || "http://127.0.0.1:3000";
const FUSION_LOG = `${homedir()}/Library/Logs/ruview.log`;

// The empty-room motion floor, measured with the room genuinely empty and
// written by scripts/ruview-baseline. Served from here so the Mac, the deck,
// /ruview and the Pi panel all scale their heat against the SAME numbers —
// a display that invents its own scale is how an empty room looks busy.
const BASELINE_FILE = `${homedir()}/cleetusd/ruview-baseline.json`;
async function loadBaseline() {
  try { return JSON.parse(await readFile(BASELINE_FILE, "utf8")); } catch { return null; }
}

/**
 * Whether multistatic fusion is actually completing cycles, and by how much it
 * is missing when it is not.
 *
 * There is no API for this — the engine's error counter appears only in the
 * log — so it is read from there. Worth the awkwardness, because this is THE
 * thing that decides whether three boards are a sensor or three boards.
 *
 * WHAT THIS REPLACED, AND WHY IT WAS WRONG. This check used to assert that
 * `offset_us` from /api/v1/mesh was near zero, on the reading that a node
 * "seconds off the leader's clock" could not be lined up in time. That is not
 * what the field means. `offset_us` is `local_minus_epoch_us` — the MEASURED
 * BOOT DELTA between boards, which is precisely what the mesh exists to
 * measure so the fuser can compensate for it (main.rs:894, and the crate's own
 * test at main.rs:9157 labels it "measured boot delta"). A large value is the
 * normal state of two boards powered on hours apart, not a fault.
 *
 * The cost of getting this wrong was real: the check reported node 1 as 75.8 s
 * off, that was read as a fault, and the board was power-cycled to fix it. The
 * offset promptly went to -21,686 s — because the board had now booted six
 * hours after the leader — while the fusion spread stayed exactly where it was
 * at 126-162 ms. A number moving by six hours with no effect on the failure is
 * the proof that it was never the cause.
 *
 * The spread is computed on epoch-aligned timestamps (multistatic.rs:295-301),
 * so it is what survives compensation. That is the number that matters.
 */
async function fusionHealth() {
  const text = await readFile(FUSION_LOG, "utf8").catch(() => null);
  if (text === null) return null;

  // RATE, not presence.
  //
  // The first version of this called fusion "failing" if the recent log held
  // any error at all. That was right when every single cycle failed, and
  // became wrong the moment the guard was fixed: fusion now clears >99% of
  // cycles and still emits the occasional warning on the tail, which the old
  // test would have reported as a total failure. A check that cannot tell
  // "broken" from "working with a tail" is worse than no check, because it
  // trains you to ignore it.
  //
  // The warning is rate-limited to one per 10 s in the server, so a fully
  // failing engine tops out at ~6/min and that ceiling is the yardstick.
  const WINDOW_S = 300;
  const now = Date.now();
  const spreads = [];
  let guard = null, recent = 0, total = null;

  for (const line of text.split("\n").slice(-1200)) {
    const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
    const tm = clean.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/);
    const em = clean.match(/total_engine_errors=(\d+)/);
    if (em) total = Number(em[1]);
    const sm = clean.match(/Timestamp spread (\d+) us exceeds guard interval (\d+) us/);
    if (!sm || !tm) continue;
    guard = Number(sm[2]) / 1000;
    const ageS = (now - Date.parse(tm[1] + "Z")) / 1000;
    if (ageS <= WINDOW_S) { recent++; spreads.push(Number(sm[1]) / 1000); }
  }

  // Measured, not guessed. With the mis-derived 120 ms guard this log ran at
  // 5.7/min for 693 minutes — pinned against the 6/min ceiling, i.e. an error
  // in nearly every bucket. With the guard set from the real distribution it
  // sits at 2.2/min, which is the tail of a working fuser rather than a broken
  // one (total_engine_errors went from 680,730 to 59). So the line between
  // "broken" and "working with a tail" belongs near the ceiling, not near zero.
  const FAILING_PER_MIN = 4.5;
  const perMin = recent / (WINDOW_S / 60);
  spreads.sort((a, b) => a - b);
  return {
    failing: perMin > FAILING_PER_MIN,
    degraded: perMin > 0.5 && perMin <= FAILING_PER_MIN,
    perMin: Number(perMin.toFixed(1)),
    windowMin: WINDOW_S / 60,
    total,
    guardMs: guard,
    medianMs: spreads.length ? spreads[Math.floor(spreads.length / 2)] : null,
    minMs: spreads.length ? spreads[0] : null,
    maxMs: spreads.length ? spreads[spreads.length - 1] : null,
    samples: spreads.length,
  };
}

// A dead server and a lying server need different sentences. Anything that
// cannot be fetched is reported as absent rather than folded into a default,
// because a default here becomes a claim about a room nobody looked at.
async function grab(path, ms = 4000) {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { __error: `http ${r.status}` };
    return await r.json();
  } catch (e) {
    return { __error: /timeout|abort/i.test(String(e.message)) ? "timeout" : "unreachable" };
  }
}

const bad = (o) => !o || o.__error;

export const READABLE = new Set([
  "health",
  "api/v1/info",
  "api/v1/metrics",
  "api/v1/nodes",
  "api/v1/mesh",
  "api/v1/mesh/metrics",
  "api/v1/vital-signs",
  "api/v1/edge-vitals",
  "api/v1/pose/current",
  "api/v1/pose/stats",
  "api/v1/pose/activities",
  "api/v1/pose/zones/summary",
  "api/v1/stream/status",
]);

/** Fetch one allowlisted path. Returns {status, body} — body is already text. */
export async function passthrough(path, search = "") {
  if (!READABLE.has(path)) {
    return { status: 404, body: JSON.stringify({
      error: "not_readable",
      detail: `/${path} is not proxied. This path is read-only on purpose — training, model loading, ` +
              `calibration and recording stay off the tunnel.`,
    }) };
  }
  try {
    const r = await fetch(`${BASE}/${path}${search}`, { signal: AbortSignal.timeout(8000) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 502, body: JSON.stringify({
      error: "unreachable",
      detail: "The RuView sensing server did not answer on this Mac.",
      cause: e.message,
    }) };
  }
}


/**
 * Everything known against the room, and why each part can or cannot be
 * believed. Exported for the doctor, which asserts the same conditions rather
 * than keeping a second opinion about the same hardware.
 */
export async function senseRoom() {
  const [nodes, mesh, poseNow, poseStats, vitals, edge, health] = await Promise.all([
    grab("/api/v1/nodes"),
    grab("/api/v1/mesh"),
    grab("/api/v1/pose/current"),
    grab("/api/v1/pose/stats"),
    grab("/api/v1/vital-signs"),
    grab("/api/v1/edge-vitals"),
    grab("/health"),
  ]);
  // /health carries no version — that lives on /api/v1/info. Asked for
  // separately rather than left as "v?" in every report that quotes it.
  const info = health && !health.__error ? await grab("/api/v1/info") : null;
  const fusion = await fusionHealth();
  const baseline = await loadBaseline();

  if (bad(health) && bad(nodes)) {
    return { up: false, why: nodes.__error || "unreachable" };
  }

  const list = Array.isArray(nodes?.nodes) ? nodes.nodes : [];
  const active = list.filter((n) => n.status === "active");
  const meshNodes = mesh?.nodes && typeof mesh.nodes === "object" ? mesh.nodes : {};

  // Distrust reasons, each derived from a field rather than asserted.
  const reasons = [];

  // 1. The server's own detection counter versus what it is streaming. This is
  //    the strongest signal available and needs no outside knowledge to read.
  const detections = poseStats?.total_detections;
  const claimed = poseNow?.total_persons ?? 0;
  if (!bad(poseStats) && detections === 0 && claimed > 0) {
    reasons.push(
      `pose/current is reporting ${claimed} ${claimed === 1 ? "person" : "people"} while ` +
      `pose/stats says total_detections is 0 after ${(poseStats.frames_processed ?? 0).toLocaleString()} ` +
      `frames. The server contradicts itself; the people are generated, not detected.`,
    );
  }

  // 2. Positions outside the room, or repeated exactly. Real fixes on distinct
  //    bodies do not land on identical coordinates.
  const persons = Array.isArray(poseNow?.persons) ? poseNow.persons : [];
  const coords = persons.map((p) => (p.position || []).map((v) => Number(v) || 0));
  const dupes = coords.length - new Set(coords.map((c) => c.join(","))).size;
  if (dupes > 0) {
    reasons.push(`${dupes} of ${coords.length} reported people share an identical coordinate with another.`);
  }
  // The room is roughly 2.6 m x 2.2 m — the node positions the server was
  // started with bound it. Anything well outside is not a person in this room.
  const outside = coords.filter((c) => Math.abs(c[0]) > 4 || Math.abs(c[2]) > 4).length;
  if (outside > 0) reasons.push(`${outside} reported position(s) fall outside the room's dimensions.`);

  // 3. Keypoint confidence. No trained pose model ships, and it shows up here
  //    as a full skeleton whose every joint is certain of nothing.
  const kp = persons[0]?.keypoints;
  if (Array.isArray(kp) && kp.length && kp.every((k) => !k.confidence)) {
    reasons.push(`every one of the ${kp.length} skeleton keypoints has confidence 0.0 — no pose model is loaded.`);
  }

  // 4. Vitals reported out of an empty buffer. A breathing rate computed from
  //    zero samples is not a measurement of anything.
  const buf = vitals?.buffer_status;
  const vitalsEmpty = buf && !buf.breathing_samples && !buf.heartbeat_samples;
  if (vitalsEmpty) {
    reasons.push(
      `vital-signs reports a breathing and heart rate while its own buffers hold ` +
      `0 breathing and 0 heartbeat samples.`,
    );
  }

  // 5. Whether the three boards are being combined into anything at all.
  //    NOT the mesh offset — see fusionHealth() for why that number is a red
  //    herring and what it cost to treat it as one.
  if (fusion && fusion.failing) {
    reasons.push(
      `multistatic fusion is failing ${fusion.perMin}/min: frames arriving in one window are spread ` +
      `${fusion.medianMs.toFixed(0)} ms apart (median of ${fusion.samples} recent, range ` +
      `${fusion.minMs.toFixed(0)}-${fusion.maxMs.toFixed(0)} ms) against a ${fusion.guardMs.toFixed(0)} ms guard` +
      (fusion.total ? `, ${fusion.total.toLocaleString()} engine errors so far` : "") +
      `. Little or nothing is being combined across boards.`,
    );
  }
  // A tail is NOT a fault and must not join the reasons list, or the room
  // reads as untrustworthy forever on the strength of one dropped cycle.

  // 6. Boards present in the fleet but missing from the mesh never contribute
  //    to a fused fix at all, however healthy they look in /nodes.
  const missingFromMesh = list.map((n) => String(n.node_id)).filter((id) => !(id in meshNodes));
  if (missingFromMesh.length) {
    reasons.push(`node ${missingFromMesh.join(", ")} is streaming but absent from the mesh, so it never joins a fused fix.`);
  }

  return {
    up: true,
    version: info && !info.__error ? info.version : null,
    fleet: list.map((n) => ({
      id: n.node_id,
      status: n.status,
      rssi: n.rssi_dbm,
      lastSeenMs: n.last_seen_ms,
      motion: n.motion_level,
      fps: meshNodes[String(n.node_id)]?.csi_fps_ema ?? null,
      offsetUs: meshNodes[String(n.node_id)]?.offset_us ?? null,
      leader: !!meshNodes[String(n.node_id)]?.is_leader,
    })),
    activeCount: active.length,
    totalCount: list.length,
    // Reported ONLY so the caller can see what was rejected. Never as an answer.
    claimedPersons: claimed,
    claimedBreathing: vitals?.vital_signs?.breathing_rate_bpm ?? null,
    claimedHeart: vitals?.vital_signs?.heart_rate_bpm ?? null,
    motionEnergy: edge?.edge_vitals?.motion_energy ?? null,
    fusion,
    baseline,
    trustworthy: reasons.length === 0,
    reasons,
  };
}

function render(r) {
  if (!r.up) {
    return (
      `The RuView sensing server is not answering on ${BASE} (${r.why}). I cannot see the room at all ` +
      `right now — do not guess at whether anyone is in it. It runs as the launch agent ` +
      `com.cleetus.ruview; restart it with: launchctl kickstart -k gui/$(id -u)/com.cleetus.ruview`
    );
  }

  const lines = [];

  // The fleet first, because it is the part that is genuinely measured.
  lines.push(`RuView sensor fleet: ${r.activeCount} of ${r.totalCount} node(s) active.`);
  for (const n of r.fleet) {
    const bits = [`node ${n.id}`, n.status];
    if (n.rssi != null) bits.push(`${n.rssi} dBm`);
    if (n.fps != null) bits.push(`${n.fps.toFixed(0)} fps`);
    if (n.leader) bits.push("mesh leader");
    // The boot delta is deliberately NOT reported as a fault here. It is the
    // gap between when this board and the leader powered on, which the mesh
    // measures so the fuser can subtract it. Printing it as "clock N s off"
    // is what sent someone to unplug a working board.
    else if (n.offsetUs != null && Math.abs(n.offsetUs) > 1_000_000) {
      bits.push(`booted ${(Math.abs(n.offsetUs) / 3600e6).toFixed(1)} h ${n.offsetUs < 0 ? "after" : "before"} the leader`);
    }
    lines.push(`  - ${bits.join(", ")}`);
  }
  if (r.totalCount < 3) {
    lines.push(
      `  Only ${r.totalCount} of the 3 boards are reporting. A board that loses power drops out of the ` +
      `fleet list entirely after a couple of minutes; it rejoins on power alone, no cable needed.`,
    );
  }

  if (r.trustworthy) {
    lines.push("");
    lines.push(
      `Every consistency check on this data passed, which has NOT been true of this deployment before. ` +
      `Report the occupancy reading, and say that the sensing checks passed rather than presenting it as ` +
      `beyond question.`,
    );
    lines.push(`Reported occupancy: ${r.claimedPersons} person(s).`);
    return lines.join("\n");
  }

  lines.push("");
  lines.push("THIS SENSOR CANNOT TELL YOU WHETHER ANYONE IS IN THE ROOM. Its occupancy output failed every");
  lines.push("consistency check below, so it is fabricated, not merely uncertain:");
  for (const why of r.reasons) lines.push(`  - ${why}`);
  lines.push("");
  lines.push(
    `For the record, the numbers being REJECTED are: ${r.claimedPersons} person(s)` +
    (r.claimedBreathing ? `, breathing ${r.claimedBreathing.toFixed(1)} bpm` : "") +
    (r.claimedHeart ? `, heart rate ${r.claimedHeart.toFixed(0)} bpm` : "") +
    `. Do not repeat any of them as fact, do not soften them into "roughly" or "around", and do not `+
    `average or reason over them. They are listed only so you can see what was thrown away.`,
  );
  lines.push(
    `If Grayson asked whether anyone is in the studio, the honest answer is that RuView cannot tell — ` +
    `the boards are alive and streaming, but the occupancy layer on top of them does not work. Say that. ` +
    `If you need to know who is at the desk, the face recogniser on the camera is a real answer and this is not.`,
  );
  return lines.join("\n");
}

export const ruviewTools = {
  room_sense: {
    schema: {
      description:
        "Read the RuView WiFi sensing fleet in Grayson's studio: how many ESP32 sensor boards are alive, " +
        "their frame rate, link quality and clock sync, plus whatever the server claims about occupancy — " +
        "checked against itself before any of it is passed on. CALL THIS BEFORE ANSWERING anything about " +
        "who or what is in the studio, whether anyone is home, whether Grayson is at his desk, whether the " +
        "room is empty, or whether the WiFi sensors are working. Never answer those from memory or from " +
        "what you were told earlier in the conversation — the room changes and the sensors flap. " +
        "IMPORTANT: this deployment's occupancy output is currently fabricated, and the tool says so " +
        "explicitly when it is. When it does, report that RuView cannot tell you who is in the room; do NOT " +
        "repeat the person count, breathing rate or heart rate it prints, even hedged.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    async run() {
      return render(await senseRoom());
    },
  },
};
