// src/tools/tracking.mjs — watching, as opposed to looking.
//
// `look` (vision.mjs) sends ONE frame to a VLM and gets a sentence back. That
// answers "what is on my desk" and nothing else, because a single frame has no
// identities in it: it sees a mug, and if asked again it sees a mug, and it
// cannot tell you whether that is the same mug. Every question about a ROOM
// rather than a PICTURE needs identity over time —
//
//   is my wallet still there        an identity that persisted
//   how long has that been out      an identity with an age
//   did anybody come in             an identity that is new
//   did anything move               an identity with a path
//
// so this samples several seconds of frames, detects in each, and runs
// ByteTrack over the detections to keep identities across them. See
// track_cli.py for the algorithm and for why it is the one chosen.
//
// TWO DIFFERENT KINDS OF ANSWER, AND THEY SHOULD NOT BE MERGED
// The tracker knows GEOMETRY: 91 COCO classes, boxes, pixels moved, seconds
// present. The VLM knows MEANING: whose mug, what the label says, what he
// appears to be doing. Neither can do the other's half, so `watch` reports the
// tracker's half plainly and the model is told to say `look` is where the rest
// comes from. Blending them in this file would produce confident sentences
// about objects the tracker never saw.

import { execFile } from "node:child_process";
import { CONFIG } from "../config.mjs";

// Same interpreter as the face recogniser and the desk light: studio-locate's
// venv is the one on this machine with OpenCV, torch and torchvision in it.
// Borrowed rather than duplicated — a second 2GB venv to run one script would
// be a second thing to keep in step.
const PY = process.env.CLEETUSD_PYTHON || `${CONFIG.home}/studio-locate/.venv/bin/python`;
const SCRIPT = `${CONFIG.home}/cleetusd/track_cli.py`;

function py(args, ms) {
  return new Promise((resolve) => {
    execFile(PY, [SCRIPT, ...args], { timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000 },
      (err, stdout, stderr) => {
        const raw = String(stdout || "").trim();
        if (raw) {
          try { return resolve(JSON.parse(raw)); } catch { /* fall through */ }
        }
        resolve({
          ok: false,
          error: err?.killed
            ? `the tracker did not finish in ${Math.round(ms / 1000)}s`
            : (String(stderr || err?.message || "no output").split("\n").pop() || "no output").slice(0, 200),
        });
      });
  });
}

/** One line per object, in the order a person would read them out. */
function render(r) {
  if (!r.ok) return `Could not track: ${r.error}`;
  const head =
    `${r.camera} camera (${r.view}) — ${r.frames} frames over ${r.seconds}s at ${r.effective_fps}fps, ` +
    `detector ${r.detector}, ${r.tracker}.`;
  if (!r.objects.length) {
    return `${head}\n\nNothing tracked. Either the view is empty of things this detector knows ` +
      `(it knows the 91 COCO classes: people, phones, cups, bottles, laptops, keyboards, books, ` +
      `chairs and so on — not keys, wallets, pens or cables), or whatever is there was too small ` +
      `or too still to detect. Use look for anything outside that list.`;
  }
  const lines = r.objects.map((o) => {
    const bits = [
      `#${o.id} ${o.what}`,
      `seen in ${o.seen_in_frames} of ${r.frames} frames`,
      o.still_present ? "still there at the end" : "gone before the end",
      `${o.seconds_present}s`,
      o.settled ? "has not moved" : `moved ${o.moved_px}px`,
      `confidence ${o.confidence}`,
    ];
    return `- ${bits.join(" · ")}`;
  });
  return `${head}\n\n${lines.join("\n")}\n\n` +
    `Each #id is ONE physical object followed across the frames, so "#3 cup" in two different ` +
    `readings is the same cup. Report only what is listed. The tracker names a shape, not a ` +
    `possession — it cannot tell his mug from any other mug, and it does not read labels. If he ` +
    `asked something the boxes cannot answer, call look at the same camera and answer from that.`;
}

export const trackTools = {
  watch: {
    schema: {
      description:
        "Watch through one of the desk cameras for a few seconds and track the objects in it, " +
        "keeping a stable id for each one across the frames. Use for anything about a thing OVER " +
        "TIME rather than in a snapshot: is it still there, how long has it been sitting out, did " +
        "it move, did somebody come in, how many people are in the room. For 'what is this' or " +
        "'read that label', use look instead — this one recognises shapes from a fixed list of 91 " +
        "everyday objects and knows nothing about what they mean.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string", enum: ["desk", "room"], description: "desk is the overhead BRIO; room is the C920 across the room." },
          seconds: { type: "number", description: "How long to watch. 5 to 10 is usually right; 60 is the ceiling." },
          classes: { type: "string", description: "Optional comma-separated filter, e.g. 'person' or 'cup,bottle,cell phone'. Leave empty to track everything." },
        },
        required: ["camera"],
      },
    },
    async run({ camera, seconds, classes }) {
      const secs = Math.min(Math.max(Number(seconds) || 6, 2), 60);
      // The wall clock has to cover the watch itself PLUS loading the detector,
      // which is a couple of seconds cold and is not part of `seconds`. A
      // timeout equal to the watch length would kill every call on the first
      // run of the day, which is the run where it is most confusing.
      const r = await py(
        ["watch", "--camera", String(camera || ""), "--seconds", String(secs),
         ...(classes ? ["--classes", String(classes)] : [])],
        (secs + 45) * 1000,
      );
      return render(r);
    },
  },

  detect: {
    schema: {
      description:
        "Take one frame from a camera and list the objects in it with their positions, without " +
        "tracking. Cheaper and instant. Use when he only wants to know what is there right now and " +
        "the answer does not depend on time.",
      parameters: {
        type: "object",
        properties: { camera: { type: "string", enum: ["desk", "room"] } },
        required: ["camera"],
      },
    },
    async run({ camera }) {
      const r = await py(["once", "--camera", String(camera || "")], 60_000);
      if (!r.ok) return `Could not detect: ${r.error}`;
      if (!r.objects.length) {
        return `Nothing the detector knows is in the ${r.camera} frame right now (${r.view}). ` +
          `It knows the 91 COCO classes only; use look for anything else.`;
      }
      return `${r.camera} camera (${r.view}), one frame, detector ${r.detector}:\n` +
        r.objects.map((o) => `- ${o.what} (${o.confidence}) at ${o.box.join(", ")}`).join("\n") +
        `\n\nReport only these. Do not name brands, colours or objects that are not listed.`;
    },
  },
};
