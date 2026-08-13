// src/tools/faces.mjs — telling WHO from a face, not guessing it.
//
// vision.mjs already answers "what can you see". It cannot answer "who is
// that", and worse, it will happily seem to: a VLM shown a man at a desk on
// Grayson's own camera says "that's Grayson" because that is the likely
// sentence, having never seen his face and having no way to express doubt. The
// room camera has caught three people in one frame; "the likely sentence" is
// not good enough for a question with a name in the answer.
//
// So identity is measured, not described. face_cli.py runs YuNet and SFace
// over the same frame the eyes use and returns numbers; this file turns those
// numbers into a sentence, and — the part that matters — refuses to turn a
// number below the threshold into a name.
//
// PYTHON, and specifically studio-locate's venv, for the same reason
// devices.mjs shells out to litra_cli.py: OpenCV lives over there and is
// already the thing looking at these cameras. Building a second imaging stack
// in Node to avoid one execFile would be the expensive way to have two.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { CONFIG } from "../config.mjs";
import { CAMERAS } from "./vision.mjs";

const run = promisify(execFile);

const PY = process.env.CLEETUSD_PYTHON || `${CONFIG.home}/studio-locate/.venv/bin/python`;
const CLI = `${CONFIG.home}/cleetusd/face_cli.py`;

// Enrolment holds the camera for shots x interval seconds and identify has to
// wait for a frame plus two model loads, so the two get different budgets.
async function face(args, timeout = 15_000) {
  if (!existsSync(PY)) {
    return { ok: false, error: "no_python",
             detail: `no Python with OpenCV at ${PY}. Set CLEETUSD_PYTHON.` };
  }
  try {
    const { stdout } = await run(PY, [CLI, ...args.map(String)], { timeout });
    return JSON.parse(stdout);
  } catch (e) {
    // face_cli.py prints JSON on stdout even when it exits non-zero, and that
    // JSON names the actual problem. The exec error just says "exit 1".
    try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    return { ok: false, error: "unreachable", detail: e.message };
  }
}

function camera(name) {
  return CAMERAS[String(name || "").toLowerCase()] || null;
}

/** Errors phrased so the model knows whether to retry, tell him, or give up. */
function explain(r) {
  switch (r.error) {
    case "no_models":
      return "the face models are not downloaded, so nobody can be recognised. " +
        "They go in cleetusd/models/face as yunet.onnx and sface.onnx (" + r.detail + ").";
    case "camera_down":
      return `that camera did not give up a frame: ${r.detail}`;
    case "no_python":
    case "unreachable":
      return `the face recogniser could not run: ${r.detail || r.error}`;
    case "nothing_captured":
      return `no face was captured: ${r.detail}`;
    case "too_far_away":
      return `${r.detail} — they need to be closer to the camera`;
    case "never_faced_camera":
      // Not a fault. Everything worked and he never looked over, and the reply
      // has to say that, or he goes looking for a broken camera.
      return `${r.detail}. Nothing is wrong with the camera — the face has to be turned toward it`;
    case "shots_disagree":
      return r.detail;
    default:
      return `${r.error}${r.detail ? ": " + r.detail : ""}`;
  }
}

// Said in the RESULT, not only in the system prompt, because the result is the
// sentence the model actually reads at the moment it answers. The `look` tool
// learned this the hard way: handed a description, the model filled in an
// iPhone and a mouse that were never in the picture. An unknown face is the
// same trap with higher stakes — "someone I don't recognise" must not become a
// name just because a name would sound better.
const RELAY =
  "\n\nUse only what is written above. Do not put a name on a face reported as unrecognised, " +
  "and do not add people who are not listed.";

export const faceTools = {
  who_is_there: {
    schema: {
      description:
        "Look through a camera and say WHO is there by name, using faces Grayson has enrolled. " +
        "Use this for who is at my desk, who is in the room, is anyone with me, am I in frame, " +
        "is somebody behind me, is anyone home, do you recognise this person. This is the tool " +
        "that knows names — 'look' only describes what a camera sees and cannot identify anyone.",
      parameters: {
        type: "object",
        properties: {
          camera: {
            type: "string",
            enum: ["room", "desk"],
            description: "'room' is the webcam facing across the room and is almost always the right one for people. 'desk' points straight down at the desk and only ever sees a face by accident.",
          },
        },
        required: [],
      },
    },
    async run({ camera: which }) {
      const name = which ? String(which).toLowerCase() : "room";
      const cam = camera(name);
      if (!cam) return `No camera called "${which}". Use room or desk.`;

      const r = await face(["identify", "--url", cam.url]);
      if (!r.ok) return `Could not check who is there — ${explain(r)}`;

      if (!r.enrolled.length) {
        return "Nobody has been enrolled yet, so faces can be seen but not named. " +
          `The ${name} camera shows ${r.faces.length} face(s) right now. ` +
          "To fix that, Grayson faces the camera and asks you to learn his face.";
      }
      if (!r.faces.length) {
        return `Nobody is in front of the ${name} camera (${cam.what}) right now — no face at all in the frame.${RELAY}`;
      }

      const named = [], unknown = [], distant = [];
      for (const f of r.faces) {
        if (f.too_small) { distant.push(f); continue; }
        if (f.name) named.push(f);
        else unknown.push(f);
      }

      const bits = [];
      for (const f of named) {
        // The score is carried through on purpose. A match at 0.41 and a match
        // at 0.78 are both "him" by the threshold, and only one of them should
        // survive being argued with.
        bits.push(`${f.name} (match ${f.score}${f.reliable ? "" : ", small in frame so less certain"})`);
      }
      if (unknown.length) {
        bits.push(`${unknown.length} face${unknown.length > 1 ? "s" : ""} that ${unknown.length > 1 ? "do" : "does"} not match anyone enrolled` +
          (unknown.some((f) => f.score !== null) ? ` (closest ${Math.max(...unknown.map((f) => f.score ?? 0))}, below the ${r.threshold} needed)` : ""));
      }
      if (distant.length) {
        bits.push(`${distant.length} more too far away to identify (about ${distant.map((f) => f.height + "px").join(", ")} tall)`);
      }

      return `Through the ${name} camera (${cam.what}) right now: ${bits.join("; ")}. ` +
        `Enrolled faces: ${r.enrolled.join(", ")}.${RELAY}`;
    },
  },

  learn_face: {
    schema: {
      description:
        "Learn someone's face from the camera so you can recognise them later. Use when Grayson " +
        "says learn my face, remember my face, this is what I look like, or asks you to learn " +
        "someone else who is standing in front of the camera. The person must be facing the " +
        "camera while this runs — it takes several seconds of shots.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Who this face belongs to, e.g. Grayson." },
          camera: { type: "string", enum: ["room", "desk"], description: "Defaults to room, the webcam facing across the room." },
        },
        required: ["name"],
      },
    },
    async run({ name, camera: which }) {
      const camName = which ? String(which).toLowerCase() : "room";
      const cam = camera(camName);
      if (!cam) return `No camera called "${which}". Use room or desk.`;

      // --wait bounds the whole thing, so the timeout only has to outlast it.
      const r = await face(["enroll", "--name", name, "--url", cam.url,
                            "--shots", "10", "--interval", "0.5", "--wait", "25"], 40_000);
      if (!r.ok) {
        return `Did not learn that face — ${explain(r)}. Nothing was saved. ` +
          "Ask them to look at the camera and try again.";
      }

      const notes = [];
      if (r.dropped_as_someone_else?.length) {
        notes.push(`${r.dropped_as_someone_else.length} shot(s) were dropped because the face in them did not match the rest`);
      }
      if (r.frozen_frame_suspected) {
        // Ten identical shots is the camera stuck, not ten angles learned. It
        // would still "work" — and would fail the first time he tilted his head.
        notes.push("every shot was nearly identical, which usually means the camera served one frozen frame — " +
          "the enrolment is thin and should be repeated once the camera is live");
      }
      if (r.rejected?.turned_away) notes.push(`it waited through ${r.rejected.turned_away} frames of them facing away`);

      return `Learned ${r.name} from ${r.captured} shot(s) through the ${camName} camera. ` +
        `${r.total_embeddings} face sample(s) are now stored for them in ${r.gallery}.` +
        (notes.length ? ` Worth mentioning: ${notes.join("; ")}.` : "") +
        ` The pictures that were learned are saved for him to check: ${(r.crops || []).slice(0, 3).join(", ")}` +
        (r.crops?.length > 3 ? `, and ${r.crops.length - 3} more` : "") + ".";
    },
  },

  known_faces: {
    schema: {
      description:
        "List whose faces you have actually learned. Call this BEFORE answering any question about " +
        "whether you know a face: do you know what I look like, do you recognise me, would you know " +
        "me if you saw me, whose faces do you know, can you tell people apart. You cannot answer " +
        "these from memory — whether a face is enrolled is a fact on disk that changes, and saying " +
        "yes without checking is how you end up describing a camera that has never seen his face.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const r = await face(["list"], 10_000);
      if (!r.ok) return `Could not read the face gallery — ${explain(r)}`;
      if (!r.people.length) return "No faces learned yet. Nobody can be recognised by name until someone is enrolled.";
      return "Faces you can recognise: " +
        r.people.map((p) => `${p.name} (${p.embeddings} sample${p.embeddings === 1 ? "" : "s"})`).join(", ") +
        `. Stored in ${r.gallery}.`;
    },
  },
};

export { face as faceRaw };
