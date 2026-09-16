// src/tools/meross.mjs — the Meross strips, without going through Shortcuts.
//
// The Shortcuts bridge works, but it is write-only and state-blind: a Shortcut
// reports that IT ran, never that the accessory answered, and there is no
// HomeKit state readable on this Mac at all (see the protocols note). So a
// Shortcut can switch the diffuser and leave me guessing about whether it is on.
// The Meross path returns real per-outlet state, which is the whole point of
// moving off Shortcuts.
//
// READ AND WRITE ARE SEPARATE TOOLS, same reasoning as hue.mjs: a single tool
// with a mode argument gets called with the write mode when the model only
// meant to look, and a diffuser coming on at 3am is not an idempotent read.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const PY = join(homedir(), ".config/meross/venv/bin/python");
const CTL = join(homedir(), ".config/meross/ctl.py");
const CREDS = join(homedir(), ".config/meross/creds.json");

// The strips were onboarded by scanning their HomeKit code, so they never
// registered with the Meross cloud and there is no account to log in to. That
// returns "Email unregistered", which reads like a typo and is not one. The
// only fix is a factory reset and re-onboarding through the Meross app.
const NOT_SET_UP =
  "Meross is not set up: there is no cached token at ~/.config/meross/creds.json. " +
  "The MSS425F strips were added to Apple Home by scanning the HomeKit setup code, so no Meross " +
  "account exists and logging in cannot work until a strip is factory-reset and re-onboarded " +
  "through the Meross app. Until then the only route to these outlets is a Shortcut. " +
  "Do NOT claim an outlet was switched.";

function configured() {
  return existsSync(CREDS) && existsSync(PY) && existsSync(CTL);
}

async function ctl(args) {
  try {
    const { stdout } = await run(PY, [CTL, ...args], { timeout: 45_000 });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || "").trim(), err: (e.stderr || e.message || "").trim() };
  }
}

export const merossTools = {
  plugs_read: {
    schema: {
      description:
        "Read the real, current state of every Meross device in Grayson's room: both surge-protector " +
        "strips outlet by outlet, and the Smart Essential Oil Diffuser (its spray mode and its lamp). " +
        "CALL THIS BEFORE ANSWERING " +
        "anything about whether the diffuser is running, whether an outlet is on, or what is " +
        "plugged in where. Never answer any of those from memory or from earlier in this " +
        "conversation — an outlet can be switched from the Meross app, from Apple Home, from Siri " +
        "or by a scene at any moment, so a remembered answer is a guess, not a reading.",
      parameters: {
        type: "object",
        properties: {
          strip: { type: "string", description: "An Apple Home name — a strip ('Desk', 'Nightstand'), a single outlet ('Helix', 'Turtle Lamp', 'Desk Screen', 'Right Main Monitor', 'Phone And Pi'), or 'Diffuser'. Omit to read everything." },
        },
        required: [],
      },
    },
    async run({ strip }) {
      if (!configured()) return NOT_SET_UP;
      if (strip) {
        const r = await ctl(["state", strip]);
        return r.ok ? r.out : `Could not read "${strip}": ${r.err || r.out}`;
      }
      const list = await ctl(["list"]);
      if (!list.ok) return `Could not reach the Meross devices: ${list.err || list.out}`;
      // Address each device by UUID, never by the name column. Both strips ship
      // with the identical name "Smart Surge Protector", so a name lookup is
      // ambiguous by construction and the picker correctly refuses it.
      const uuids = [...list.out.matchAll(/\b[0-9a-f]{32}\b/g)].map((m) => m[0]);
      if (!uuids.length) return list.out;
      const parts = [];
      for (const u of uuids) {
        const s = await ctl(["state", u]);
        parts.push(s.ok ? s.out : `${u}: unreadable (${s.err || s.out})`);
      }
      return parts.join("\n\n");
    },
  },

  plugs_set: {
    schema: {
      description:
        "Switch a Meross device on or off: an outlet on a surge-protector strip, or the diffuser. " +
        "For the diffuser, on starts it misting at LIGHT and off stops it; pass mode for STRONG. " +
        "This physically changes something in the room Grayson is sitting in, so use it when he asks " +
        "and not to explore. Read plugs_read first if you need the current state — do not assume it. " +
        "Switching a strip outlet off cuts mains power to its load outright; never do that to " +
        "something mid-task without being asked.",
      parameters: {
        type: "object",
        properties: {
          strip: { type: "string", description: "An Apple Home name: a strip ('Desk', 'Nightstand'), a single outlet ('Helix', 'Turtle Lamp', 'Desk Screen', 'Right/Left Main Monitor', 'Desk USB', 'Phone And Pi'), or 'Diffuser'. Naming an outlet already selects its channel." },
          channel: { type: "number", description: "Rarely needed — naming an outlet already picks its channel. 0 is the WHOLE strip and cuts every outlet at once. Ignored for the diffuser." },
          on: { type: "boolean", description: "true to switch on, false to switch off." },
          mode: { type: "string", enum: ["light", "strong"], description: "Diffuser only: mist strength when switching on. Defaults to light." },
        },
        required: ["strip", "on"],
      },
    },
    async run({ strip, channel, on, mode }) {
      if (!configured()) return NOT_SET_UP;
      // DO NOT default the channel to 0 here. Channel 0 is the WHOLE STRIP, and
      // passing it explicitly overrode the alias's own channel -- so naming a
      // single outlet ("Helix") cut mains to every outlet on that strip,
      // monitors included. Omit the argument entirely and let ctl.py use the
      // channel the Apple Home alias resolved to.
      const args = on && mode === "strong"
        ? ["spray", strip, "strong"]
        : [on ? "on" : "off", strip, ...(channel == null ? [] : [String(Math.trunc(channel))])];
      const r = await ctl(args);
      if (!r.ok) return `Did NOT switch "${strip}" channel ${ch}: ${r.err || r.out}`;
      // ctl.py re-reads the device after writing, so this line is a readback, not an echo.
      return r.out;
    },
  },
};
