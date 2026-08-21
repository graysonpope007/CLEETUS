// src/tools/hue.mjs — Cleetus can turn the lights on now.
//
// /protocols has had a lighting layer written into it for weeks with nothing
// behind it, because the audit believed a Hue Bridge still had to be bought.
// One was already on the network. These two tools are what make that layer
// executable rather than descriptive.
//
// WHY READ AND WRITE ARE SEPARATE TOOLS. A single "lights" tool with a mode
// argument gets called with the write mode when the model only meant to look,
// and a lamp changing state is not an idempotent read. Splitting them means
// the destructive one has to be chosen on purpose.

import { lights, rooms, groupFor, setGroup, flash, hueConfigured } from "../hue.mjs";

const NOT_SET_UP =
  "The Hue bridge is not configured: HUE_APP_KEY is missing from cleetus.env. Minting a new one " +
  "needs a human to press the physical link button on the bridge at 192.168.1.70 and a POST to " +
  "/api within about 30 seconds. Do NOT claim the lights were changed.";

export const hueTools = {
  lights_read: {
    schema: {
      description:
        "Read the real, current state of every Philips Hue light in Grayson's room: which lamps exist, " +
        "whether each is on or off, and its brightness. CALL THIS BEFORE ANSWERING anything about " +
        "whether the lights are on, whether the room is lit, how bright it is, or which lamps exist. " +
        "Never answer any of those from memory or from earlier in this conversation — a lamp can be " +
        "switched at the wall or from the Hue app at any moment, so a remembered answer is a guess.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    async run() {
      if (!hueConfigured()) return NOT_SET_UP;
      const [ls, rs] = await Promise.all([lights(), rooms()]);
      const out = ls.map(
        (l) => `  - ${l.name}: ${l.on ? "ON" : "off"}${l.brightness != null ? ` at ${Math.round(l.brightness)}%` : ""}` +
               `${l.reachable ? "" : "  (UNREACHABLE — powered down at the wall)"}`,
      );
      return [
        `Hue bridge 192.168.1.70, ${ls.length} lamp(s) in ${rs.length} room(s): ${rs.map((r) => r.name).join(", ")}.`,
        ...out,
        "",
        `${ls.filter((l) => l.on).length} of ${ls.length} are on right now.`,
      ].join("\n");
    },
  },

  lights_set: {
    schema: {
      description:
        "Turn Grayson's Hue lights on or off, set their brightness, or flash them as an alert. " +
        "This physically changes the lighting in the room he is sitting in, so use it when he asks " +
        "for it and not to explore. Read the lights first with lights_read if you need to know the " +
        "current state — do not assume it.",
      parameters: {
        type: "object",
        properties: {
          room: { type: "string", description: "Room name, e.g. 'Bedroom'. Defaults to the only room if there is one." },
          on: { type: "boolean", description: "true to switch on, false to switch off." },
          brightness: { type: "number", description: "0-100. Only applied when switching on." },
          flash: { type: "boolean", description: "Flash the room red as an alert, then put it back exactly as it was." },
        },
        required: [],
      },
    },
    async run({ room, on, brightness, flash: doFlash }) {
      if (!hueConfigured()) return NOT_SET_UP;
      const rs = await rooms();
      const name = room || (rs.length === 1 ? rs[0].name : null);
      if (!name) return `Which room? The bridge has: ${rs.map((r) => r.name).join(", ")}.`;
      const group = await groupFor(name);
      if (!group) return `No room called "${name}". The bridge has: ${rs.map((r) => r.name).join(", ")}.`;

      if (doFlash) {
        await flash(group);
        return `Flashed ${name} red four times and restored every lamp to the exact state it was in.`;
      }
      if (on === undefined && brightness == null) {
        return "Nothing to do: pass on, brightness or flash.";
      }
      await setGroup(group, { on, brightness });
      const bits = [];
      if (on !== undefined) bits.push(on ? "on" : "off");
      if (brightness != null) bits.push(`${Math.round(brightness)}% brightness`);
      return `${name} is now ${bits.join(" at ")}.`;
    },
  },
};
