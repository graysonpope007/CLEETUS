// src/govee.mjs — the Govee plugs, as a third control source alongside Meross
// and Hue. These are the "Keys" station sockets (Keys monitors, Keys monitor
// left/right) that live on the Govee cloud, not on Apple Home's Meross/Hue, so
// the wall panel could never see them until now.
//
// It shells out to ~/.local/bin/govee (the existing bash helper, cloud API),
// because that already holds the API key, the name matching and the
// ambiguous-match refusal. The only care needed is PATH: the helper calls
// `python3`, and /usr/bin/python3 is the Xcode license shim on this Mac, so a
// real interpreter has to be ahead of it.
//
// TWO TRAPS carried from the govee memory note:
//   - An OFFLINE plug still reports a cached powerSwitch. `online` is read
//     first; if false the state is unknown and a write will not land, so the
//     panel shows it as unreachable rather than lying.
//   - Do not cut mains to powered speakers without intent. Which of these plugs
//     feed speakers vs a screen is a physical fact set in the layout, not here.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const HELPER = join(homedir(), ".local/bin/govee");
const CREDS = join(homedir(), ".config/govee/govee.env");
// A real python3 ahead of the Xcode shim, plus the helper's own dir.
const PATH = `/opt/homebrew/bin:/usr/local/bin:${join(homedir(), ".local/bin")}:/usr/bin:/bin`;

export function goveeConfigured() {
  return existsSync(HELPER) && existsSync(CREDS);
}

async function govee(args, timeout = 15_000) {
  const { stdout } = await run("bash", [HELPER, ...args], { timeout, env: { ...process.env, PATH } });
  return stdout.trim();
}

/** Parse `govee list` -> [{name, model, id}]. */
export async function goveeList() {
  const out = await govee(["list"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(.*?)\s{2,}(\S+)\s+(\S+)$/);
    return m ? { name: m[1].trim(), model: m[2], id: m[3] } : { name: l, model: null, id: null };
  });
}

/** Read one plug: {name, online, on}. online:false => on is unknown. */
export async function goveeState(name) {
  const out = await govee(["state", name]);
  const online = /online\s*=\s*true/i.test(out);
  const on = /powerSwitch\s*=\s*1/.test(out);
  return { name, online, on: online ? on : null, raw: out };
}

/** Switch one plug and read it back. Never an echo of what was asked. */
export async function goveeSet(name, on) {
  await govee([on ? "on" : "off", name], 25_000);
  return goveeState(name);
}
