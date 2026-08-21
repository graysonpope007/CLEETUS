// src/tools/roomwatch.mjs — the room alarm, from wherever Grayson is.
//
// WHY THIS IS A TOOL AND NOT A ROUTE ON /api/reach.
//
// You arm an alarm at the moment you LEAVE, which is exactly the moment you are
// not at the Mac. So arming had to be reachable from the phone. The obvious
// path — another route on the /reach proxy — is the wrong one: that proxy is
// deliberately read-only, by exact name, and it refuses anything that changes
// state on the machine. Widening it for this would trade a carefully drawn
// boundary for one feature.
//
// A tool costs nothing extra. The phone already talks to /api/cleetusd, which
// is session-gated and carries the bearer the browser cannot hold, and Cleetus
// already has the judgement to know that "arm the room" and "is the alarm on"
// are different requests. So "arm the alarm" typed into the app on his way out
// of the door works, and the read-only proxy stays read-only.

import { readState, writeState, loadBaseline, logEvent, cameraProbe, whoIsThere, PATHS } from "../roomwatch.mjs";
import { readFile } from "node:fs/promises";

async function recentEvents(n = 6) {
  try {
    const text = await readFile(PATHS.events, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
  } catch { return []; }
}

export const roomwatchTools = {
  room_alarm: {
    schema: {
      description:
        "Read or change the state of the room alarm (roomwatch) in Grayson's studio: whether it is armed, " +
        "what it has seen recently, and whether its camera can currently see the room. CALL THIS BEFORE " +
        "ANSWERING anything about whether the alarm is on, whether the room is being watched, whether " +
        "anything has been detected, or whether it is safe to leave. Never answer any of those from memory " +
        "or from earlier in the conversation — the alarm can be armed or disarmed from the Mac at any time. " +
        "IMPORTANT: arming and disarming physically change whether Grayson gets woken by a notification, so " +
        "only pass `action` when he has actually asked for it.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "arm", "disarm"],
            description: "status (default) just reads. arm starts a 60-second exit delay so he can walk out. disarm stops all alarms.",
          },
          exit_delay_seconds: {
            type: "number",
            description: "How long after arming before movement counts. Defaults to 60 — long enough to reach the door.",
          },
        },
        required: [],
      },
    },
    async run({ action = "status", exit_delay_seconds }) {
      const base = await loadBaseline();
      const state = await readState();

      if (action === "arm" || action === "disarm") {
        const armed = action === "arm";
        const delay = armed ? Number(exit_delay_seconds ?? 60) : 0;
        await writeState({
          ...state, armed,
          armed_at: armed ? Date.now() + delay * 1000 : null,
          since: armed ? new Date().toISOString() : null,
        });
        logEvent({ kind: armed ? "armed" : "disarmed", by: "cleetus" });
        return armed
          ? `The room alarm is arming now and goes live in ${delay} seconds, so there is time to get out of ` +
            `the room. After that, confirmed movement with no recognised face sends a push and flashes the ` +
            `lights. Tell him it is armed and how long he has.`
          : `The room alarm is disarmed. Movement is still logged, but nothing will alert him.`;
      }

      // status
      const lines = [];
      lines.push(state.armed
        ? `The room alarm is ARMED (since ${state.since}).` +
          (state.armed_at && Date.now() < state.armed_at
            ? ` It is still in its exit delay for another ${Math.round((state.armed_at - Date.now()) / 1000)}s.`
            : "")
        : "The room alarm is DISARMED. It is watching and logging, but it will not alert him.");

      if (!base) {
        lines.push("It has no baseline, which means it is not running at all. It needs a recording of the empty room first.");
        return lines.join(" ");
      }

      // Whether the eye that actually guards the room can see anything right
      // now. Reported because "armed" and "able to see" are different facts and
      // an alarm with a dead camera is the failure nobody notices.
      const cam = await cameraProbe({ frames: 4, gapMs: 200, tag: "tool" });
      if (!cam.ok) lines.push(`WARNING: the confirming camera is not readable right now (${cam.error}), so the alarm is effectively blind.`);
      else if (cam.frozen) lines.push("WARNING: the camera stream is FROZEN — identical frames — so the alarm cannot see, even though it looks healthy.");
      else lines.push(`The camera is live and ${cam.max_changed_pct >= (base.camera?.trip ?? 0.5) ? `sees movement right now (${cam.max_changed_pct}% of the frame)` : "sees a still room"}.`);

      const who = await whoIsThere();
      if (who.ok && who.named.length) lines.push(`${who.named.join(" and ")} ${who.named.length > 1 ? "are" : "is"} in front of the camera.`);

      const evs = await recentEvents(6);
      if (evs.length) {
        const alarms = evs.filter((e) => e.action === "alarm").length;
        lines.push(`Its last ${evs.length} events: ${evs.map((e) => e.action || e.kind).join(", ")}${alarms ? ` (${alarms} alarm${alarms > 1 ? "s" : ""})` : ""}.`);
      }

      // The honest caveat, carried from the measurement rather than asserted.
      lines.push(
        `On how it works: the WiFi sensors raise the first alert and the camera confirms, but the WiFi stage ` +
        `was measured and does not actually separate an occupied room from an empty one, so the camera's ` +
        `30-second heartbeat is what is really guarding the room. Say that if he asks how reliable it is; ` +
        `do not describe the WiFi sensing as working.`,
      );
      return lines.join(" ");
    },
  },
};
