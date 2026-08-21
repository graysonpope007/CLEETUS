// src/hue.mjs — the room's lights, finally reachable.
//
// The Rev 1.5 audit listed lighting as BLOCKED on buying a Hue Bridge. There
// has been one on the network the entire time: a BSB002 at 192.168.1.70. It
// went unfound because `arp` only holds recently-contacted hosts and everyone
// greps for the old `00:17:88` OUI, while this bridge is `c4:29:96`. Use
// `dns-sd -t 4 -B _hue._tcp` or https://discovery.meethue.com instead.
//
// The application key was minted 2026-08-21 with Grayson pressing the link
// button, and lives in cleetus.env as HUE_APP_KEY.
//
// TWO THINGS THIS FILE REFUSES TO DO, both learned rather than assumed:
//
//   1. It never resolves a group by NAME at call time. Audit finding A6: names
//      are editable in the Hue app, so a rename silently retargets whatever
//      "bedroom" meant. Rooms are addressed by UUID, cached in cleetus.env, and
//      the name is used only to LOOK UP the UUID once when it is missing.
//
//   2. It never writes a group brightness in order to "restore" it afterwards.
//      A grouped_light PUT overwrites the stored brightness of every lamp in
//      the group, INCLUDING lamps that are switched off — so a blink that sets
//      the group to 100% and then restores only the lamps that were on leaves
//      the off lamps to come on at full next time somebody touches the switch.
//      Measured exactly that on the first run. Snapshots and restores are
//      therefore per-LIGHT and include brightness for off lamps too.
//
// The bridge serves a self-signed certificate, so every request goes through
// node:https with rejectUnauthorized:false. That is safe here and only here:
// the target is a fixed private IP on the LAN, not a name resolved at runtime.

import { request as httpsRequest } from "node:https";
import { secrets } from "./config.mjs";

const IP = secrets.HUE_BRIDGE_IP || "192.168.1.70";
const KEY = secrets.HUE_APP_KEY || "";

export function hueConfigured() {
  return Boolean(KEY);
}

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpsRequest(
      {
        host: IP, port: 443, path, method,
        rejectUnauthorized: false,            // self-signed bridge cert, fixed LAN IP
        headers: {
          "hue-application-key": KEY,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          try { resolve(JSON.parse(out)); }
          catch { reject(new Error(`hue ${res.statusCode}: ${out.slice(0, 200)}`)); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("hue bridge timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Every light, with the two fields anything here cares about. */
export async function lights() {
  const d = await call("GET", "/clip/v2/resource/light");
  return (d.data || []).map((l) => ({
    id: l.id,
    name: l.metadata?.name || "?",
    on: Boolean(l.on?.on),
    brightness: l.dimming?.brightness ?? null,
    reachable: l.status?.reachable !== false,
  }));
}

/** Rooms, each with the grouped_light service that is the thing you PUT to. */
export async function rooms() {
  const d = await call("GET", "/clip/v2/resource/room");
  return (d.data || []).map((r) => ({
    id: r.id,
    name: r.metadata?.name || "?",
    group: (r.services || []).find((s) => s.rtype === "grouped_light")?.rid || null,
    lights: (r.children || []).length,
  }));
}

/**
 * The grouped_light UUID for a room. Prefers the cached value in cleetus.env
 * (HUE_GROUP_<NAME>), falls back to one lookup by name, and NEVER caches the
 * name itself — see note 1 at the top of this file.
 */
export async function groupFor(roomName) {
  const cached = secrets[`HUE_GROUP_${String(roomName).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (cached) return cached;
  const all = await rooms();
  const hit = all.find((r) => r.name.toLowerCase() === String(roomName).toLowerCase());
  return hit?.group || null;
}

/** Per-LIGHT state, enough to put the room back exactly as it was. */
export async function snapshot() {
  const ls = await lights();
  return Object.fromEntries(ls.map((l) => [l.id, { on: l.on, brightness: l.brightness, name: l.name }]));
}

/** Restore a snapshot(), brightness included for lamps that were off. */
export async function restore(snap) {
  for (const [id, s] of Object.entries(snap)) {
    const body = { on: { on: s.on } };
    if (s.brightness != null) body.dimming = { brightness: s.brightness };
    await call("PUT", `/clip/v2/resource/light/${id}`, body);
    await sleep(350);                          // the bridge rate-limits; ~3/s is safe
  }
}

export async function setGroup(groupId, { on, brightness, color } = {}) {
  const body = {};
  if (on !== undefined) body.on = { on: Boolean(on) };
  if (brightness != null) body.dimming = { brightness: Math.max(0, Math.min(100, brightness)) };
  if (color) body.color = { xy: color };       // CIE xy; see ALERT_RED below
  return call("PUT", `/clip/v2/resource/grouped_light/${groupId}`, body);
}

// CIE xy for a saturated red. Hue takes xy, not RGB, and a "red" guessed as
// {0.7,0.3} lands outside some lamps' gamut and is silently clamped to orange.
export const ALERT_RED = [0.6915, 0.3083];

/**
 * Flash a room, then put it back exactly as it was.
 *
 * This is a real alert channel and not decoration: SMS is dead on this stack
 * (Twilio 30032, toll-free number never verified), so a physical signal in the
 * room is one of the few ways to say something loudly to whoever is standing
 * in it.
 */
export async function flash(groupId, { times = 4, ms = 350, color = ALERT_RED } = {}) {
  const snap = await snapshot();
  try {
    for (let i = 0; i < times; i++) {
      await setGroup(groupId, { on: true, brightness: 100, color });
      await sleep(ms);
      await setGroup(groupId, { on: false });
      await sleep(ms);
    }
  } finally {
    // finally, not after: a throw mid-flash must not leave the room dark and red.
    await restore(snap);
  }
  return { flashed: times };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
