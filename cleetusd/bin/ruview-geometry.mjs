#!/usr/bin/env node
// ruview-geometry.mjs: pull the room layout drawn at cleetusai.com/geometry and
// turn it into the things RuView actually consumes.
//
// The layout used to live in a hand-written room-geometry.json, trilaterated on
// paper from three tape measurements. That was fine once and wrong the moment a
// board moved, and there was no way to notice it had gone wrong: the server
// takes --node-positions on faith and reports confident coordinates from stale
// input.
//
// So this does three things and refuses to guess at any of them:
//   . writes room-geometry.json from the SAVED layout, provenance included
//   . prints the --node-positions flag built from those same coordinates
//   . COMPARES that flag to the one the running LaunchAgent is actually using,
//     because a plist edited but not reloaded is the failure this project has
//     already paid for twice
//
// Usage:  ruview-geometry.mjs            show, compare, change nothing
//         ruview-geometry.mjs --write    also write room-geometry.json
//         ruview-geometry.mjs --plist    also rewrite the plist flag (prints
//                                        the reload command; does not run it)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { secrets } from "../src/config.mjs";

const KEY = "room_geometry";
const OUT = path.join(os.homedir(), "Desktop/Cleetus/room-geometry.json");
const PLIST = path.join(os.homedir(), "Library/LaunchAgents/com.cleetus.ruview.plist");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

async function load() {
  const url = secrets.SUPABASE_URL, key = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from cleetus.env");
  const r = await fetch(`${url}/rest/v1/app_kv?select=value,updated_at&key=eq.${KEY}&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`app_kv read failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!rows[0]) throw new Error(`nothing saved under app_kv "${KEY}" yet.\n`
    + `Open https://cleetusai.com/geometry, mark the room, press Solve, press Save.`);
  return { g: rows[0].value, at: rows[0].updated_at };
}

const ft = (m) => {
  const t = m / 0.0254, f = Math.floor(t / 12);
  return `${f}'${(t - f * 12).toFixed(1)}"`;
};

// A path only senses a body it passes THROUGH, so the useful output is not the
// coordinates, it is which transmitter-to-node lines cross a body and at what
// height. Ported from the page deliberately: this has to be checkable from a
// terminal with the browser shut, and it has to give the SAME answer.
//
// It reads EVERY zone. The version this replaced took the first point of kind
// "seat" and silently ignored every other one, so a room measured with a desk
// chair, a keys stool and a bed reported on one third of itself and said
// nothing about the rest.
const ZONE_KINDS = ["seat", "bed"];
const isZone = (p) => ZONE_KINDS.includes(p.kind);

// A body is a SEGMENT with a radius, which covers both postures with one piece
// of maths. Seated, the segment is vertical: chest above knees at one spot.
// Lying, it is horizontal at mattress height and about two metres long, so it
// needs a heading. Treating a bed as a seated cylinder is wrong in both
// directions at once: too wide across the mattress, and far too tall.
function bodyOf(p, g) {
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
// LINE and range-checking the height separately, as the old code did, cannot
// express a horizontal body at all.
function segSeg(p1, q1, p2, q2) {
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

// Every zone, not just the first one found.
function pathAnalysis(g) {
  const zones = g.points.filter(isZone);
  const txs = g.points.filter((p) => p.kind === "transmitter");
  const nodes = g.points.filter((p) => p.kind === "node");
  if (!zones.length || !txs.length || !nodes.length) return [];
  return zones.map((z) => {
    const B = bodyOf(z, g), out = [];
    for (const tx of txs) for (const n of nodes) {
      const A = [tx.x, tx.y, tx.z], C = [n.x, n.y, n.z];
      const { dist, s, height } = segSeg(A, C, B.a, B.b);
      const span = Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
      const ends = s > 0.08 && s < 0.92 && span > 1.0;
      const through = dist <= B.r && ends;
      const grazes = !through && dist <= B.r * 2.2 && ends;
      out.push({ tx: tx.name, node: n.name, node_id: n.node_id, span, off: dist,
                 height, t: s, through, grazes, tooClose: span <= 1.0 });
    }
    out.sort((a, b) => (b.through - a.through) || (a.off - b.off));
    return { zone: z, body: B, paths: out,
             hits: out.filter((p) => p.through).length,
             ctrl: out.filter((p) => !p.through && !p.grazes && !p.tooClose).length };
  });
}

const { g, at } = await load();
const nodes = g.points.filter((p) => p.kind === "node" && p.node_id != null)
  .sort((a, b) => a.node_id - b.node_id);
// Negative zero formats as "-0.000", which would report a disagreement with the
// plist for a layout that had not moved at all.
const z3 = (v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
const flag = nodes.map((p) => `${z3(p.x)},${z3(p.y)},${p.z.toFixed(2)}`).join(";");

console.log(`saved ${new Date(at).toLocaleString()}   ${g.points.length} points, ${g.measurements.length} distances`);

// The fit is the only reason to trust any of the numbers below it, so it goes
// first and it goes in loud when it is bad.
if (g.solve) {
  const rms = g.solve.residual_rms_m * 100, worst = g.solve.worst_m * 100;
  const verdict = rms < 4 ? "fits" : rms < 10 ? "LOOSE" : "DOES NOT FIT";
  console.log(`fit: ${verdict}, typical error ${rms.toFixed(1)} cm, worst ${worst.toFixed(1)} cm`);
  if (rms >= 10) console.log(`     Treat every coordinate below as unreliable. One distance is probably\n`
                           + `     mistyped, or the layout is mirrored. Fix it on the page before using this.`);
} else {
  console.log(`fit: NEVER SOLVED. These coordinates are wherever they were dragged to,\n`
            + `     not a solution to the measurements. Press Solve on the page.`);
}

console.log(`\nNODES`);
for (const p of nodes)
  console.log(`  ${String(p.node_id).padEnd(2)} ${p.name.padEnd(18)} ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, z ${p.z.toFixed(2)}   ${p.note || ""}`);
const unnumbered = g.points.filter((p) => p.kind === "node" && p.node_id == null);
for (const p of unnumbered)
  console.log(`  ?  ${p.name.padEnd(18)} NO NODE ID, so it is missing from the flag below`);

const Z = pathAnalysis(g);
for (const z of Z) {
  console.log(`\nRADIO PATHS THROUGH ${z.zone.name.toUpperCase()}  (${z.body.label})`);
  for (const p of z.paths) {
    const verdict = p.tooClose ? "too short to judge"
                  : p.through  ? "THROUGH YOU"
                  : p.grazes   ? "grazes you"
                  : "clear of you";
    console.log(`  ${p.tx} to ${p.node.padEnd(16)} ${p.span.toFixed(2)} m (${ft(p.span)}), `
      + `${(p.off * 100).toFixed(0)} cm off you at ${p.height.toFixed(2)} m   ${verdict}`);
  }
  const hits = z.paths.filter((p) => p.through);
  if (hits.length) {
    console.log(`  ${hits.length} through, ${z.ctrl} clean controls.`);
    for (const h of hits)
      console.log(`    node ${h.node_id ?? "?"} (${h.node}):  --filter-mac <the transmitter BSSID>`);
  } else {
    console.log(`  NOTHING crosses this one, so nothing here will sense it.`);
  }
}
if (Z.length) {
  const anyHit = Z.some((z) => z.hits > 0);
  if (anyHit) {
    console.log(`\n  Provision the listed nodes against the transmitter and leave the rest as`);
    console.log(`  controls. Do NOT pin --channel: the node auto-detects the AP's channel and`);
    console.log(`  a pin goes silently dead if the router ever moves.`);
    console.log(`  Then power-cycle and LEAVE THE ROOM for 90 s: the per-node presence`);
    console.log(`  threshold is learned from the first 1200 frames after boot.`);
  } else {
    console.log(`\n  Nothing crosses any zone, so nothing here will sense anybody. Move the`);
    console.log(`  transmitter until a body lies between it and at least one node.`);
  }
}

console.log(`\n--node-positions ${flag || "(no numbered nodes)"}`);

// A plist edited without a reload is this project's most expensive recurring
// bug, so compare against what is RUNNING, not against what is on disk.
if (fs.existsSync(PLIST) && flag) {
  const live = (fs.readFileSync(PLIST, "utf8")
    .match(/<string>--node-positions<\/string>\s*<string>([^<]*)<\/string>/) || [])[1];
  if (live === flag) console.log(`plist agrees.`);
  else {
    console.log(`\nPLIST DISAGREES with the saved layout:`);
    console.log(`  plist: ${live ?? "(flag absent)"}`);
    console.log(`  saved: ${flag}`);
    if (has("--plist")) {
      const src = fs.readFileSync(PLIST, "utf8");
      const next = live == null
        ? src.replace(/(<\/array>)/, `  <string>--node-positions</string><string>${flag}</string>\n  $1`)
        : src.replace(/(<string>--node-positions<\/string>\s*<string>)[^<]*(<\/string>)/, `$1${flag}$2`);
      fs.writeFileSync(PLIST, next);
      console.log(`  plist rewritten. It is NOT live until you reload it, and kickstart -k`);
      console.log(`  will not re-read an edited plist:`);
      console.log(`    launchctl unload ${PLIST} && launchctl load -w ${PLIST}`);
    } else console.log(`  Pass --plist to rewrite it.`);
  }
}

if (has("--write")) {
  const doc = {
    _note: "RuView node, seat and transmitter geometry. Metres. Generated by "
         + "bin/ruview-geometry.mjs from the layout saved at cleetusai.com/geometry. "
         + "Do not hand-edit: the next run overwrites it.",
    _provenance: `${g.measurements.length} tape distances, solved by least squares on the page. `
      + (g.solve ? `Residual ${(g.solve.residual_rms_m * 100).toFixed(1)} cm typical, `
                 + `${(g.solve.worst_m * 100).toFixed(1)} cm worst.`
                 : "NEVER SOLVED: coordinates are hand-placed, not fitted."),
    _saved_at: at,
    measurements: g.measurements.map((m) => {
      const a = g.points.find((p) => p.id === m.a), b = g.points.find((p) => p.id === m.b);
      return { from: a?.name, to: b?.name, m: +m.d.toFixed(4), as_measured: m.raw || ft(m.d) };
    }),
    points: g.points.map((p) => ({
      name: p.name, kind: p.kind, node_id: p.node_id,
      x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(3), where: p.note || undefined,
    })),
    body: g.body,
    // Keyed BY ZONE. The old shape was a flat list called paths_through_seat and
    // it described one zone while claiming to describe the room.
    paths_by_zone: Z.map((z) => ({
      zone: z.zone.name,
      kind: z.zone.kind,
      posture: z.body.post,
      body: z.body.label,
      through: z.hits,
      clean_controls: z.ctrl,
      paths: z.paths.map((p) => ({
        from: p.tx, to: p.node, node_id: p.node_id,
        span_m: +p.span.toFixed(3), off_body_m: +p.off.toFixed(3),
        crosses_at_height_m: +p.height.toFixed(3),
        through: p.through, grazes: p.grazes, too_short_to_judge: p.tooClose,
      })),
    })),
    server_flag: `--node-positions ${flag}`,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}
