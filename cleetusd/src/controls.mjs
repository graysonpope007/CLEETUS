// src/controls.mjs — one list of everything in the room that can be tapped.
//
// The wall panel needs a single shape covering two very different systems: Hue
// lamps (local, fast, per-lamp) and Meross outlets (cloud, ~2 s, per-channel).
// Merging them here rather than in the page means the panel stays a renderer and
// the naming/safety rules live in one place.
//
// NAMES COME FROM APPLE HOME, read live. Meross calls both strips "Smart Surge
// Protector" and its outlets "Switch 1..4"; the Hue bridge calls three of four
// lamps "Hue Essential lamp N". Neither is usable on a wall.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";
import { lights, lightDevices, lightDetail, setLight, hueConfigured } from "./hue.mjs";
import { goveeConfigured, goveeState, goveeSet } from "./govee.mjs";
import { wemoState, wemoSet } from "./wemo.mjs";

const run = promisify(execFile);
const PY = join(CONFIG.home, ".config/meross/venv/bin/python");
const CTL = join(CONFIG.home, ".config/meross/ctl.py");
const NAMES = join(CONFIG.home, ".config/meross/homenames.py");

import { CONTROL_LAYOUT as LAYOUT, PROTECTED_CONTROLS } from "./control-layout.mjs";

// ── What must never be tappable ──
//
// The Pi runs off the Nightstand USB bank. A tap that cuts it kills the panel
// AND the only way to turn it back on, so this is a trap that disables its own
// undo. It is rendered, greyed, and refuses the write server-side — a page-only
// guard would be one stale deploy away from useless.
const PROTECTED = [
  { match: /phone and pi/i, why: "this outlet powers the Pi running this panel" },
];
// Channel 0 is the whole strip, not a socket. Tapping it would cut every outlet
// at once, which no one means when they reach for one thing.
const isWholeStrip = (ch) => ch === 0;

function protectedReason(name) {
  const hit = PROTECTED.find((p) => p.match.test(name || ""));
  return hit ? hit.why : null;
}

async function homeNames() {
  try {
    const { stdout } = await run("python3", [NAMES], { timeout: 10_000 });
    return JSON.parse(stdout);
  } catch {
    return { outlets: {}, hue: {} };
  }
}

/**
 * Parse the one JSON line out of a CLI's stdout.
 *
 * meross_iot occasionally prints something of its own AFTER the payload — a
 * RuntimeWarning about an un-awaited coroutine, most often — and a plain
 * JSON.parse of the whole stream then throws "Unexpected non-whitespace
 * character". Intermittently. The visible effect is the panel silently losing
 * every Meross device while the Hue half keeps working, which reads as the
 * strips going offline. ctl.py emits its payload as a single line, so take the
 * first line that parses and ignore the noise around it.
 */
function jsonLine(stdout) {
  for (const line of String(stdout).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  throw new Error("no JSON object in output: " + String(stdout).slice(0, 120));
}

// ── merossd first, ctl.py second ──
//
// merossd (~/.config/meross/merossd.py, launchd com.cleetus.merossd) holds ONE
// warm cloud session and answers from memory: a read is ~20 ms and a tap is
// under a second. ctl.py is the cold path -- login, MQTT, discovery, poll --
// and measured 9 s per read and ~15 s per tap from the wall panel, because a
// tap is three cold starts. Both emit the same payload shape, so the caller
// never has to know which one answered; if the daemon is down the panel gets
// slower, not blind.
const MEROSSD = process.env.MEROSSD_URL || "http://127.0.0.1:8772";

async function merossd(path, init = {}) {
  const r = await fetch(`${MEROSSD}${path}`, {
    ...init,
    signal: AbortSignal.timeout(init.method === "POST" ? 25_000 : 4_000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `merossd ${r.status}`);
  return body;
}

async function merossState() {
  try {
    return await merossd("/state");
  } catch (e) {
    console.error(`[controls] merossd unavailable (${e.message}); cold path via ctl.py`);
  }
  const { stdout } = await run(PY, [CTL, "json"], { timeout: 30_000 });
  return jsonLine(stdout);
}

/** One write, with readback of that device. Returns the device entry. */
async function merossWrite(uuid, chRaw, on) {
  const body = chRaw === "spray" ? { uuid, on } : { uuid, channel: Number(chRaw), on };
  try {
    const r = await merossd("/set", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return r.device;
  } catch (e) {
    console.error(`[controls] merossd write failed (${e.message}); cold path via ctl.py`);
  }
  const args = [CTL, on ? "on" : "off", uuid];
  if (chRaw !== "spray") args.push(String(chRaw));
  await run(PY, args, { timeout: 30_000 });
  const after = await merossState();
  return (after.devices || []).find((d) => d.uuid === uuid);
}

// ── Govee state, cached ──────────────────────────────────────────────────────
// A Govee read is a cloud round trip (~1-2 s), and the panel polls /controls
// every 2 s, so reading the plug on every poll would drag the whole panel back
// to slow. Plug state changes rarely, so it is cached for 8 s and refreshed the
// instant a write lands. `null` on is "offline, state unknown" (see govee.mjs).
const GOVEE_TTL = 8_000;
const goveeCache = new Map();   // name -> { at, state }
const WEMO_TTL = 4_000;
const wemoCache = new Map();    // host -> { at, state }
async function wemoCached(host) {
  const hit = wemoCache.get(host);
  if (hit && Date.now() - hit.at < WEMO_TTL) return hit.state;
  const state = await wemoState(host);   // wemoState never throws; returns online:false on failure
  wemoCache.set(host, { at: Date.now(), state });
  return state;
}
async function goveeCached(name) {
  const hit = goveeCache.get(name);
  if (hit && Date.now() - hit.at < GOVEE_TTL) return hit.state;
  try {
    const state = await goveeState(name);
    goveeCache.set(name, { at: Date.now(), state });
    return state;
  } catch (e) {
    return hit?.state || { name, online: false, on: null, error: String(e.message || e) };
  }
}

/** Build the panel from LAYOUT, filling each item with live state. */
export async function readControls() {
  const wantsHue = LAYOUT.some((g) => g.items.some((i) => i.kind === "hue"));
  const wantsGovee = LAYOUT.some((g) => g.items.some((i) => i.kind === "govee"));
  const [names, meross, hueBundle] = await Promise.all([
    homeNames(),
    merossState().catch((e) => ({ error: String(e.message || e), devices: [] })),
    wantsHue && hueConfigured()
      ? Promise.all([lights(), lightDevices(), lightDetail()]).catch((e) => ({ error: String(e.message || e) }))
      : Promise.resolve(null),
  ]);

  const merossByUuid = new Map((meross.devices || []).map((d) => [d.uuid, d]));
  const outlet = (uuid, ch) => (merossByUuid.get(uuid)?.outlets || []).find((o) => o.channel === ch);

  let hueByLight = new Map(), hueDetailById = new Map(), hueOnline = false;
  if (Array.isArray(hueBundle)) {
    const [ls, devs, det] = hueBundle;
    hueOnline = true;
    const dByLight = new Map(devs.map((d) => [d.lightId, d]));
    hueDetailById = new Map(det.map((d) => [d.id, d]));
    hueByLight = new Map(ls.map((l) => [l.id, { light: l, dev: dByLight.get(l.id) }]));
  }

  const hueItem = (it) => {
    const rec = hueByLight.get(it.lightId);
    if (!rec) return { id: `hue:${it.lightId}`, name: it.label || "Lamp", on: false, reachable: false, protected: null, offline: true };
    const { light: l, dev: d } = rec;
    const c = hueDetailById.get(l.id);
    const home = d && names.hue ? names.hue[d.deviceId] : null;
    return {
      id: `hue:${l.id}`,
      name: it.label || home || l.name,
      on: Boolean(l.on),
      detail: l.brightness != null ? `${Math.round(l.brightness)}%` : null,
      named_in_home: Boolean(home),
      reachable: l.reachable,
      protected: null,
      dimmable: Boolean(c?.brightness != null),
      brightness: c?.brightness ?? null,
      minDim: c?.minDim ?? 2,
      colorCapable: Boolean(c?.color),
      xy: c?.color?.xy ?? null,
      ctCapable: Boolean(c?.ct),
      mirek: c?.ct?.mirek ?? null,
      ctRange: c?.ct ? [c.ct.min, c.ct.max] : null,
    };
  };

  const groups = [];
  for (const col of LAYOUT) {
    const items = [];
    for (const it of col.items) {
      if (it.kind === "meross") {
        const o = outlet(it.uuid, it.channel);
        items.push({
          id: `meross:${it.uuid}:${it.channel}`,
          name: it.label || o?.name || `outlet ${it.channel}`,
          on: Boolean(o?.on),
          named_in_home: Boolean(o?.named_in_home),
          reachable: Boolean(o),
          protected: PROTECTED_CONTROLS.get(`meross:${it.uuid}:${it.channel}`) || protectedReason(o?.name || it.label),
          confirm: it.confirm || null,
        });
      } else if (it.kind === "merossMerge") {
        const outs = it.channels.map((ch) => outlet(it.uuid, ch));
        const allOn = outs.length > 0 && outs.every((o) => o?.on);
        const anyOn = outs.some((o) => o?.on);
        items.push({
          id: `merossmerge:${it.uuid}:${it.channels.join("+")}`,
          name: it.label,
          on: allOn,
          detail: anyOn && !allOn ? "one on" : null,   // surfaces a split state
          reachable: outs.every(Boolean),
          protected: null,
        });
      } else if (it.kind === "diffuser") {
        const dev = merossByUuid.get(it.uuid);
        items.push({
          id: `meross:${it.uuid}:spray`,
          name: it.label || dev?.name || "Diffuser",
          on: Boolean(dev?.running),
          detail: dev?.spray || null,
          reachable: Boolean(dev),
          protected: null,
        });
      } else if (it.kind === "hue") {
        items.push(hueItem(it));
      } else if (it.kind === "govee") {
        const st = wantsGovee && goveeConfigured() ? await goveeCached(it.device) : { online: false, on: null };
        items.push({
          id: `govee:${it.device}`,
          name: it.label || it.device,
          on: Boolean(st.on),
          reachable: Boolean(st.online),
          detail: st.online ? null : "offline",
          confirm: it.confirm || null,     // page arms-then-fires when set
          protected: null,
        });
      } else if (it.kind === "appletv") {
        // State is fetched separately so an offline TV never slows the lights.
        items.push({ id: "appletv:gp-tv", kind: "appletv", name: it.label,
          on: null, reachable: true, protected: null, remote: true, bulkExclude: true });
      } else if (it.kind === "wemo") {
        const st = await wemoCached(it.host);
        items.push({
          id: `wemo:${it.host}`,
          name: it.label || "WeMo",
          on: Boolean(st.on),
          reachable: Boolean(st.online),
          detail: st.online ? null : "offline",
          confirm: it.confirm || null,
          protected: null,
        });
      }
    }
    groups.push({ name: col.name, number: col.number, kind: col.kind || "mixed", online: true, items });
  }

  return { at: Math.floor(Date.now() / 1000), groups, meross_error: meross.error || null };
}

/**
 * Switch one thing. Returns the READBACK, never an echo of what was asked —
 * a control surface that reports its own intent is how a dead outlet keeps
 * looking healthy.
 */
export async function setControl(id, on, opts = {}) {
  const [system, ...rest] = String(id || "").split(":");
  const { brightness, xy, mirek } = opts;
  if (PROTECTED_CONTROLS.has(id)) return { ok: false, error: "refused: " + PROTECTED_CONTROLS.get(id) };

  if (system === "hue") {
    if (!hueConfigured()) return { ok: false, error: "Hue is not configured" };
    const lightId = rest.join(":");
    await setLight(lightId, { on, brightness, xy, mirek });
    const det = await lightDetail();
    const l = det.find((x) => x.id === lightId);
    return {
      ok: true, id, on: Boolean(l?.on),
      detail: l?.brightness != null ? `${Math.round(l.brightness)}%` : null,
      brightness: l?.brightness ?? null,
      xy: l?.color?.xy ?? null,
      mirek: l?.ct?.mirek ?? null,
    };
  }

  if (system === "meross") {
    const [uuid, chRaw] = rest;
    // Re-derive the guard from live state rather than trusting the id the page
    // sent: the page could be a stale deploy, and "which outlet is this" is
    // exactly the thing that must not be taken on trust.
    const state = await merossState();
    const dev = (state.devices || []).find((d) => d.uuid === uuid);
    if (!dev) return { ok: false, error: `no device ${uuid}` };

    if (chRaw !== "spray") {
      const ch = Number(chRaw);
      if (isWholeStrip(ch)) return { ok: false, error: "channel 0 is the whole strip; refused" };
      const outlet = (dev.outlets || []).find((o) => o.channel === ch);
      const why = protectedReason(outlet?.name);
      if (why) return { ok: false, error: `refused: ${why}` };
    }

    const d2 = await merossWrite(uuid, chRaw, on);
    if (chRaw === "spray") return { ok: true, id, on: Boolean(d2?.running), detail: d2?.spray || null };
    const o2 = (d2?.outlets || []).find((o) => o.channel === Number(chRaw));
    return { ok: true, id, on: Boolean(o2?.on) };
  }

  // Both desk monitors as one. Switch every channel, then read the strip back
  // once and report on = ALL on, so a partial failure shows as off rather than
  // claiming success.
  if (system === "merossmerge") {
    const [uuid, chSpec] = rest;
    const channels = chSpec.split("+").map(Number);
    let d2;
    for (const ch of channels) d2 = await merossWrite(uuid, String(ch), on);
    const outs = channels.map((ch) => (d2?.outlets || []).find((o) => o.channel === ch));
    const allOn = outs.length > 0 && outs.every((o) => o?.on);
    const anyOn = outs.some((o) => o?.on);
    return { ok: true, id, on: allOn, detail: anyOn && !allOn ? "one on" : null };
  }

  // Govee plug (the Keys station). Refuse if offline: a write cannot land and a
  // false success is worse than a clear "unreachable". The speaker-pop guard is
  // the page's two-tap confirm; by the time it reaches here the intent is set.
  if (system === "govee") {
    if (!goveeConfigured()) return { ok: false, error: "Govee is not configured" };
    const name = rest.join(":");
    const before = await goveeState(name).catch(() => ({ online: false }));
    if (!before.online) return { ok: false, error: `${name} is offline; cannot switch it` };
    const after = await goveeSet(name, on);
    goveeCache.set(name, { at: Date.now(), state: after });
    return { ok: true, id, on: Boolean(after.on), detail: after.online ? null : "offline" };
  }

  if (system === "wemo") {
    const host = rest.join(":");
    const after = await wemoSet(host, on);
    wemoCache.set(host, { at: Date.now(), state: after });
    if (!after.online) return { ok: false, error: `the keys screen (WeMo ${host}) is not reachable` };
    return { ok: true, id, on: Boolean(after.on) };
  }

  return { ok: false, error: `unknown control id: ${id}` };
}
