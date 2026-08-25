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
// coordinates, it is which transmitter-to-node lines cross the seat and at what
// height. Duplicated from the page deliberately: this has to be checkable from
// a terminal with the browser shut.
function paths(g) {
  const seat = g.points.find((p) => p.kind === "seat");
  const txs = g.points.filter((p) => p.kind === "transmitter");
  const nodes = g.points.filter((p) => p.kind === "node");
  if (!seat || !txs.length || !nodes.length) return [];
  const B = g.body || { radius_m: 0.2, z_low_m: 0.45, z_high_m: 1.3 };
  const out = [];
  for (const tx of txs) for (const n of nodes) {
    const dx = n.x - tx.x, dy = n.y - tx.y, L2 = dx * dx + dy * dy;
    const t = L2 < 1e-9 ? 0 : ((seat.x - tx.x) * dx + (seat.y - tx.y) * dy) / L2;
    const tc = Math.max(0, Math.min(1, t));
    const px = tx.x + dx * tc, py = tx.y + dy * tc, pz = tx.z + (n.z - tx.z) * tc;
    const off = Math.hypot(px - seat.x, py - seat.y);
    const span = Math.hypot(dx, dy, n.z - tx.z);
    out.push({ tx: tx.name, node: n.name, node_id: n.node_id, span, off, height: pz,
      through: off <= B.radius_m && pz >= B.z_low_m && pz <= B.z_high_m && t > 0.08 && t < 0.92 && span > 1.0 });
  }
  return out.sort((a, b) => (b.through - a.through) || (a.off - b.off));
}

const { g, at } = await load();
const nodes = g.points.filter((p) => p.kind === "node" && p.node_id != null)
  .sort((a, b) => a.node_id - b.node_id);
const flag = nodes.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(2)}`).join(";");

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

const P = paths(g);
if (P.length) {
  console.log(`\nRADIO PATHS THROUGH THE SEAT`);
  for (const p of P)
    console.log(`  ${p.tx} to ${p.node.padEnd(16)} ${p.span.toFixed(2)} m (${ft(p.span)}), `
      + `${(p.off * 100).toFixed(0)} cm off you at ${p.height.toFixed(2)} m   ${p.through ? "THROUGH YOU" : "clear of you"}`);
  const hits = P.filter((p) => p.through);
  if (hits.length) {
    console.log(`\n  Point these nodes at the transmitter and leave the rest as controls:`);
    for (const h of hits) console.log(`    node ${h.node_id ?? "?"} (${h.node}):  --filter-mac <the transmitter BSSID>  --channel 1`);
    console.log(`  Then power-cycle and LEAVE THE ROOM for 90 s: the per-node presence\n`
              + `  threshold is learned from the first 1200 frames after boot.`);
  } else {
    console.log(`\n  Nothing crosses you, so nothing here will sense you. Move the transmitter\n`
              + `  until your seat lies between it and at least one node.`);
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
    paths_through_seat: P.map((p) => ({
      from: p.tx, to: p.node, node_id: p.node_id,
      span_m: +p.span.toFixed(3), off_seat_m: +p.off.toFixed(3),
      crosses_at_height_m: +p.height.toFixed(3), through: p.through,
    })),
    server_flag: `--node-positions ${flag}`,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}
