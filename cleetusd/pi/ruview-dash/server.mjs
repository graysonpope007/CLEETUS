// ruview-dash — the studio's WiFi sensing fleet, on the Pi's panel.
//
// Runs on the Raspberry Pi as a systemd --user service. Three jobs:
//
//   1. Hold the bearer. The page must never carry it: this box serves the
//      dashboard to the tailnet as well as to its own screen, and a token in
//      the markup is a token given away to everything that can load it.
//   2. Poll the Mac and keep a little history. /room is computed on the Mac
//      by cleetusd (one place decides what is trustworthy, and it is not
//      this file); edge-vitals is sampled faster because it is the only
//      endpoint carrying motion energy, and it reports ONE node per call,
//      rotating between them. Bucketing those samples by node_id is the only
//      way to get a per-node motion trace out of this server.
//   3. Serve the page.
//
// WHY IT DOES NOT TALK TO THE SENSING SERVER DIRECTLY. That server is on the
// Mac's loopback, sends no CORS headers, and has no auth. cleetusd already
// fronts it with a read-only allowlist and is already on the tunnel behind a
// bearer, so this reaches the room the same way a phone does.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RUVIEW_DASH_PORT || 8790);
const HOST = process.env.RUVIEW_DASH_HOST || "0.0.0.0";

// The token file is the deployment's one secret. Read once at boot: if it is
// missing the dashboard still comes up and says so on its own face, because a
// blank screen in a room is indistinguishable from a box that is switched off.
const TOKEN_FILE = process.env.RUVIEW_TOKEN_FILE ||
  join(homedir(), "..", "..", "opt", "protocol-pi", "secrets", "ruview.token");
const TOKEN = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
const UPSTREAM = (process.env.RUVIEW_UPSTREAM || "https://me.cleetusai.com").replace(/\/+$/, "");

const HISTORY = 72;          // samples kept per node, ~1 per second
const state = {
  room: null,
  roomAt: 0,
  roomError: TOKEN ? null : "no token file",
  motion: new Map(),         // node_id -> [{t, energy}]
  lastEnergy: new Map(),
};

async function up(path) {
  if (!TOKEN) throw new Error("no token");
  const r = await fetch(`${UPSTREAM}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

async function pollRoom() {
  try {
    state.room = await up("/room");
    state.roomAt = Date.now();
    state.roomError = null;
  } catch (e) {
    // The last good reading is KEPT and its age is served alongside it, so the
    // page can grey out rather than blank. A panel that empties on one dropped
    // request teaches you to distrust it when it is right.
    state.roomError = e.message;
  }
}

async function pollMotion() {
  try {
    const d = await up("/ruview/api/v1/edge-vitals");
    const v = d && d.edge_vitals;
    if (!v || v.node_id == null) return;
    const id = String(v.node_id);
    const arr = state.motion.get(id) || [];
    arr.push({ t: Date.now(), energy: Number(v.motion_energy) || 0 });
    while (arr.length > HISTORY) arr.shift();
    state.motion.set(id, arr);
    state.lastEnergy.set(id, Number(v.motion_energy) || 0);
  } catch { /* a dropped sample is a gap in a trace, not news */ }
}

function snapshot() {
  const room = state.room;
  const fleet = (room && room.fleet ? room.fleet : []).map((n) => {
    const id = String(n.id);
    return {
      ...n,
      energy: state.lastEnergy.has(id) ? state.lastEnergy.get(id) : null,
      trace: (state.motion.get(id) || []).map((s) => s.energy),
    };
  });
  return {
    ok: !!room && room.up,
    error: state.roomError,
    ageMs: state.roomAt ? Date.now() - state.roomAt : null,
    version: room ? room.version : null,
    fleet,
    activeCount: room ? room.activeCount : 0,
    totalCount: room ? room.totalCount : 0,
    trustworthy: room ? room.trustworthy : false,
    reasons: room ? room.reasons : [],
    fusion: room ? room.fusion : null,
    claimedPersons: room ? room.claimedPersons : null,
    at: Date.now(),
  };
}

// CORS on every response, including the HTML.
//
// The scene page is served by scene_server on :8080 and probes this service on
// :8790 before handing the screen over. Different port, so a cross-origin
// fetch, so it needs this header — and without it the probe fails, the panel
// shows "RUVIEW DASHBOARD IS NOT RUNNING", and the service it is describing is
// running perfectly two ports away. Which is the SAME failure that kept
// /ruview dark for weeks on the Mac, reproduced here by the person who had
// just finished diagnosing it. Caught by screenshotting the panel rather than
// by trusting that a healthy `systemctl is-active` meant a healthy screen.
//
// A wildcard is right for this one: everything served here is read-only room
// telemetry, the bearer never leaves the process, and the alternative is an
// origin allowlist that breaks the first time the port or hostname moves.
const send = (res, code, body, type) => {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
};

createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/api/state") {
    return send(res, 200, JSON.stringify(snapshot()), "application/json");
  }
  // The live view.
  //
  // An <img> cannot attach a bearer, and this box serves the tailnet as well as
  // its own screen, so the token stays here and the stream is proxied. The
  // upstream is the SAME read-only cleetusd allowlist the rest of this file
  // uses — /airpad/stream.mjpg is the C920 the room alarm confirms with, so the
  // panel is showing the exact frames the alarm decides on rather than a second
  // opinion from a different camera.
  //
  // Backpressure is handled explicitly: the Pi's panel is slower than a 125 KB/s
  // MJPEG stream, and writing without waiting for drain buffers the difference
  // in this process's memory until it is killed.
  if (path === "/camera.mjpg") {
    if (!TOKEN) return send(res, 503, "no token file", "text/plain");
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    try {
      const r = await fetch(`${UPSTREAM}/airpad/stream.mjpg`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: ac.signal,
      });
      if (!r.ok || !r.body) return send(res, 502, `camera upstream ${r.status}`, "text/plain");
      res.writeHead(200, {
        "Content-Type": r.headers.get("content-type") || "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store",
      });
      for await (const chunk of r.body) {
        if (!res.write(chunk)) await new Promise((go) => res.once("drain", go));
      }
      res.end();
    } catch {
      // A header written twice takes the whole process down — this exact bug
      // killed the daemon on the Mac once already.
      if (!res.headersSent) send(res, 502, "camera unreachable", "text/plain");
      else res.end();
    }
    return;
  }

  if (path === "/healthz") {
    return send(res, 200, JSON.stringify({ ok: true, token: !!TOKEN, upstream: UPSTREAM }), "application/json");
  }
  if (path === "/" || path === "/index.html") {
    const html = await readFile(join(HERE, "public", "index.html"), "utf8").catch(() => null);
    if (html === null) return send(res, 500, "dashboard missing", "text/plain");
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  send(res, 404, "not found", "text/plain");
}).listen(PORT, HOST, () => {
  console.log(`ruview-dash on http://${HOST}:${PORT} -> ${UPSTREAM} (token: ${TOKEN ? "loaded" : "MISSING"})`);
});

pollRoom(); pollMotion();
setInterval(pollRoom, 2000);
setInterval(pollMotion, 1000);
