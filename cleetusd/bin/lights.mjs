#!/usr/bin/env node
// bin/lights.mjs — the room's lights from a shell: `lights.mjs status|on|off [room]`
//
// Exists so the desk trigger (~/desk-trigger/hooks/on-arrive) can do something
// real. It fired reliably for a month and only ever wrote to a log, because
// nothing outside cleetusd could reach src/hue.mjs. Same library, same rules:
// groups by cached UUID, no brightness writes (a grouped_light dimming PUT
// overwrites the stored level of lamps that are OFF).
//
//   on   — turns the room on ONLY if every lamp in it is off. A room that is
//          already lit was set by a person and is left exactly as it is.
//   off  — turns the room off, unconditionally.
//   status — one line per lamp.
//
// Prints one line saying what it did; exit 2 if Hue is not configured.

import { hueConfigured, lights, groupFor, setGroup } from "../src/hue.mjs";

const [, , cmd = "status", room = "Bedroom"] = process.argv;

if (!hueConfigured()) { console.log("hue: HUE_APP_KEY missing in cleetus.env"); process.exit(2); }

const all = await lights();
const lit = all.filter((l) => l.on);

if (cmd === "status") {
  for (const l of all) console.log(`${l.on ? "on " : "off"}  ${String(l.brightness ?? "").padStart(3)}%  ${l.name}`);
  process.exit(0);
}

const group = await groupFor(room);
if (!group) { console.log(`hue: no group for room "${room}"`); process.exit(2); }

if (cmd === "on") {
  if (lit.length) { console.log(`hue: ${room} already lit (${lit.length}/${all.length} on), left alone`); process.exit(0); }
  await setGroup(group, { on: true });
  console.log(`hue: ${room} on (${all.length} lamps, stored brightness)`);
} else if (cmd === "off") {
  await setGroup(group, { on: false });
  console.log(`hue: ${room} off (was ${lit.length}/${all.length} on)`);
} else {
  console.log("usage: lights.mjs status|on|off [room]"); process.exit(1);
}
