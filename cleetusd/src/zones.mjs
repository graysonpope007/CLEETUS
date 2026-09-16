// src/zones.mjs — presence PER ZONE, derived from the room geometry outward.
//
// RuView has per-NODE presence. That is not the same question. A node reports
// on the channel between one transmitter and itself; a zone is a place in the
// room. The two only line up where a transmitter-to-node path actually passes
// THROUGH the body standing or lying in that zone. So the zone list is computed
// from the geometry, not configured by hand, and a zone that no path crosses is
// reported as UNSENSABLE rather than as empty.
//
// That distinction is the whole point. This project has already shipped a
// dashboard that rendered /api/v1/pose/current as truth while it fabricated a
// mean of 4.5 people, peaking at 14, in a room the camera agreed was empty. A
// zone nothing crosses and a zone with nobody in it produce identical readings,
// and anything that draws them the same way is lying.
//
// One place computes this. The tool, the endpoint and the viewer all read it
// from here, the same arrangement senseRoom() already uses.
import { secrets } from "./config.mjs";

const KEY = "room_geometry";
export const ZONE_KINDS = ["seat", "bed"];
export const isZone = (p) => ZONE_KINDS.includes(p.kind);

// A seated chest sits around 1.1-1.3 m. Breathing lives in the chest, so a path
// crossing at 0.75 m is reading the lap and the abdomen instead. Crossings are
// graded rather than passed/failed because "it crosses you" and "it crosses the
// part of you that moves when you breathe" are different claims.
export const CHEST_LOW = 0.95, CHEST_HIGH = 1.45;

export async function loadGeometry() {
  const url = secrets.SUPABASE_URL, key = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from cleetus.env");
  const r = await fetch(`${url}/rest/v1/app_kv?select=value,updated_at&key=eq.${KEY}&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`app_kv read failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!rows[0]) throw new Error(`nothing saved under app_kv "${KEY}" yet`);
  return { g: rows[0].value, savedAt: rows[0].updated_at };
}

// A body is a SEGMENT with a radius, which covers both postures with one piece
// of maths. Seated it is vertical: chest above knees at one spot. Lying it is
// horizontal at mattress height and about two metres long, so it needs a
// heading. Treating a bed as a seated cylinder is wrong in both directions at
// once — too wide across the mattress, and far too tall.
export function bodyOf(p, g) {
  const D = g.body || { radius_m: 0.2, z_low_m: 0.45, z_high_m: 1.3 };
  const b = p.body || {};
  const post = p.posture || (p.kind === "bed" ? "lying" : "seated");
  const r = b.radius_m || (post === "lying" ? 0.22 : D.radius_m);
  if (post === "lying") {
    const L = b.length_m || 1.80, h = (p.heading_deg || 0) * Math.PI / 180;
    const zc = p.z ?? 0.55, hx = Math.cos(h) * L / 2, hy = Math.sin(h) * L / 2;
    return { a: [p.x - hx, p.y - hy, zc], b: [p.x + hx, p.y + hy, zc], r, post,
             label: `lying, ${L.toFixed(2)} m long` };
  }
  const lo = b.z_low_m ?? (post === "standing" ? 0.10 : D.z_low_m);
  const hi = b.z_high_m ?? (post === "standing" ? 1.75 : D.z_high_m);
  return { a: [p.x, p.y, lo], b: [p.x, p.y, hi], r, post,
           label: `${post}, ${lo.toFixed(2)} to ${hi.toFixed(2)} m` };
}

// Closest approach between two 3D segments. Comparing the path to a vertical
// LINE and range-checking the height separately cannot express a lying body.
export function segSeg(p1, q1, p2, q2) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const EPS = 1e-9;
  let s, t;
  if (a <= EPS && e <= EPS) return { dist: Math.hypot(...r), s: 0, t: 0, height: p1[2] };
  if (a <= EPS) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return { dist: Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]), s, t, height: c1[2] };
}

/** Every zone with every transmitter-to-node path scored against it. */
export function pathAnalysis(g) {
  const zones = g.points.filter(isZone);
  const txs = g.points.filter((p) => p.kind === "transmitter");
  const nodes = g.points.filter((p) => p.kind === "node");
  return zones.map((z) => {
    const B = bodyOf(z, g), out = [];
    for (const tx of txs) for (const n of nodes) {
      const A = [tx.x, tx.y, tx.z], C = [n.x, n.y, n.z];
      const { dist, s, height } = segSeg(A, C, B.a, B.b);
      const span = Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
      const ends = s > 0.08 && s < 0.92 && span > 1.0;
      const through = dist <= B.r && ends;
      const grazes = !through && dist <= B.r * 2.2 && ends;
      out.push({
        tx: tx.name, node: n.name, node_id: n.node_id ?? null,
        span_m: span, off_m: dist, height_m: height, t: s,
        through, grazes, too_short: span <= 1.0,
        // A crossing through the lap is not a crossing through the chest, and
        // only the chest tells you anything about breathing.
        chest: through && height >= CHEST_LOW && height <= CHEST_HIGH,
        // Attribution is only honest when the node is filtered to THIS
        // transmitter. Unfiltered, its CSI pools every transmitter in range and
        // the per-node numbers stop describing this link at all.
        filtered_to_tx: n.filter_mac ? (tx.bssid ? n.filter_mac.toLowerCase() === tx.bssid.toLowerCase() : null) : null,
      });
    }
    out.sort((a, b) => (b.through - a.through) || (a.off_m - b.off_m));
    return {
      zone: z.name, kind: z.kind, posture: bodyOf(z, g).post, body: B.label,
      x: z.x, y: z.y, z: z.z ?? null,
      paths: out,
      through: out.filter((p) => p.through).length,
      chest: out.filter((p) => p.chest).length,
      controls: out.filter((p) => !p.through && !p.grazes && !p.too_short).length,
    };
  });
}

/**
 * What each zone can honestly say right now.
 *
 * The state is deliberately NOT a presence boolean. There is no validated
 * per-zone detector yet — CSI presence in this room is closed as "no signal"
 * against 296 minutes of camera-verified empty and 83 of verified occupied, and
 * inventing a green light on top of that would repeat the exact failure that
 * cost this project two months. So the states are about what is KNOWABLE:
 *
 *   unsensable  no path crosses the body here. Identical readings whether the
 *               zone is occupied or not. Fix the geometry, not the threshold.
 *   unattributed  a path crosses, but the node is not known to be filtered to
 *               that transmitter, so its numbers are not a measurement of this
 *               link.
 *   no_detector a path crosses and is attributable, but nothing has been
 *               validated against ground truth for this zone yet. Evidence is
 *               shown; no verdict is issued.
 *   live        a validated detector exists. Nothing reaches this state until
 *               one passes the gate.
 */
export function zoneStates(g, live = {}) {
  const byNode = live.byNode || {};
  return pathAnalysis(g).map((z) => {
    const crossing = z.paths.filter((p) => p.through);
    let state = "unsensable", why;
    if (!crossing.length) {
      const best = z.paths.find((p) => !p.too_short);
      why = best
        ? `no path passes through this body. Closest is ${best.tx} to ${best.node}, `
          + `${(best.off_m * 100).toFixed(0)} cm away at ${best.height_m.toFixed(2)} m.`
        : `no transmitter-to-node path is long enough to judge.`;
    } else if (crossing.every((p) => p.filtered_to_tx !== true)) {
      state = "unattributed";
      why = `${crossing.length} path(s) cross you, but no crossing node is known to be `
          + `filtered to that transmitter, so its CSI pools every transmitter in range.`;
    } else {
      state = "no_detector";
      why = `${crossing.length} attributable path(s) cross you`
          + (z.chest ? `, ${z.chest} at chest height.` : `, none at chest height — `
          + `every crossing is through the lap, which carries no breathing.`);
    }
    return {
      ...z, state, why,
      evidence: crossing.map((p) => ({
        link: `${p.tx} to ${p.node}`, node_id: p.node_id,
        off_cm: +(p.off_m * 100).toFixed(0), height_m: +p.height_m.toFixed(2),
        chest: p.chest, attributable: p.filtered_to_tx === true,
        node_live: p.node_id != null ? (byNode[p.node_id] ?? null) : null,
      })),
    };
  });
}
