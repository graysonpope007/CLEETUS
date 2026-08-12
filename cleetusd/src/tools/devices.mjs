// src/tools/devices.mjs — hardware on this desk that Cleetus can actually move.
//
// The first one is the Logitech Litra Glow. It is a real physical action, so
// the tool reports the power state READ BACK FROM THE DEVICE rather than the
// state it asked for. That is not pedantry: a HID write succeeds whether or
// not the light is listening, and the obvious way to check — pointing a webcam
// at the room — does not work, because the camera's auto-exposure pulls mean
// luminance back to the same number no matter what the light does. Asking the
// device is the only answer that means anything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.mjs";

const run = promisify(execFile);

const PY = `${CONFIG.home}/studio-locate/.venv/bin/python`;
const CLI = `${CONFIG.home}/studio-locate/litra_cli.py`;

async function litra(...args) {
  try {
    const { stdout } = await run(PY, [CLI, ...args.map(String)], { timeout: 8000 });
    return JSON.parse(stdout);
  } catch (e) {
    // A non-zero exit still prints JSON on stdout; prefer that to the raw error.
    try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    return { ok: false, error: "unreachable", detail: e.message };
  }
}

function describe(r) {
  if (!r.ok) {
    if (r.error === "no_device") return "The Litra light is not plugged in.";
    return `The light did not take that: ${r.detail || r.error}`;
  }
  const power = r.on === null ? "power state unknown" : r.on ? "on" : "off";
  const bits = [`light is ${power}`];
  if (r.brightness_pct !== undefined) bits.push(`brightness ${Math.round(r.brightness_pct)}%`);
  if (r.kelvin !== undefined) bits.push(`${r.kelvin}K`);
  return bits.join(", ");
}

export const deviceTools = {
  desk_light: {
    schema: {
      description:
        "Control the Logitech Litra Glow on Grayson's desk: turn it on or off, set brightness (0-100%), or set colour temperature (2700K warm to 6500K cool). Use this for anything about the light, key light, desk light, or studio light. Reports the power state read back from the device.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "on, off, toggle, brightness, temp, or state",
          },
          value: {
            type: "number",
            description:
              "For brightness, a percentage 0-100. For temp, kelvin 2700-6500 (lower is warmer). Ignored otherwise.",
          },
        },
        required: ["action"],
      },
    },
    async run({ action, value }) {
      const a = String(action || "state").toLowerCase();
      const needsValue = a === "brightness" || a === "temp" || a === "temperature";
      if (needsValue && (value === undefined || value === null)) {
        return `${a} needs a value — brightness takes 0-100, temp takes 2700-6500.`;
      }
      const r = await litra(...(needsValue ? [a, value] : [a]));
      return describe(r);
    },
  },
};

export { litra as litraRaw };
