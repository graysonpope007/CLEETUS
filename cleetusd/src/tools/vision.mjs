// src/tools/vision.mjs — the eyes.
//
// Two cameras already watch this desk and neither of them could be ASKED
// anything. The BRIO looks down at the desk for studio-locate, the C920 looks
// across the room for the air trackpad, and both have served frames to a
// browser for weeks while the assistant sitting on the same machine had no way
// to see either one.
//
// HOW IT FITS TOGETHER. The vision model does not take the conversation over.
// laguna is the model that knows Grayson and holds every other tool; a VLM
// swapped in for the whole turn would trade all of that for sight, and swapped
// in per-message would lose the thread. So the VLM is a SENSE: it looks, it
// writes a sentence, and laguna answers with that sentence in hand. That is
// also why the prompt below asks for description and never for conclusions —
// the part that decides what a thing MEANS is the part that knows whose desk
// it is.

import { CONFIG } from "../config.mjs";
import { see, visionReady } from "../ollama.mjs";

// Where each camera points, in the words someone would use asking for it.
// Exported because faces.mjs looks through the same two eyes — a second copy of
// these URLs is a second thing to keep in step with the hardware.
export const CAMERAS = {
  desk: {
    url: "http://127.0.0.1:8765/frame.jpg",
    what: "the BRIO looking straight down at the desk, keyboard and whatever is on it",
  },
  room: {
    url: "http://127.0.0.1:8768/frame.jpg",
    what: "the C920 looking across the room, which usually has Grayson in it",
  },
};

async function grab(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`camera returned ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length < 2000) throw new Error("frame too small to be a picture");
  // Base64 without a data URL prefix — see ollama.mjs.
  let binary = "";
  for (let i = 0; i < buf.length; i += 8192) {
    binary += String.fromCharCode(...buf.subarray(i, i + 8192));
  }
  return { b64: btoa(binary), bytes: buf.length };
}

const DESCRIBE =
  "Describe what is in this picture, plainly and specifically. Name the objects you can " +
  "actually identify and say where they are. If a person is in frame, say what they appear " +
  "to be doing. If text is legible, quote it. Do not guess at anything blurred or cut off — " +
  "say it is unclear instead. Three or four sentences, no preamble.";

export const visionTools = {
  look: {
    schema: {
      description:
        "Look through one of the cameras on Grayson's desk and describe what is actually there " +
        "right now. Use whenever he asks what you can see, what is on his desk, whether he left " +
        "something out, what he is holding, or anything about the physical room. 'desk' is the " +
        "overhead camera on the desk itself; 'room' is the webcam facing across the room.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string", enum: ["desk", "room"], description: "Which camera to look through." },
          question: {
            type: "string",
            description: "Optional: what to look for, e.g. 'is my wallet on the desk'.",
          },
        },
        required: ["camera"],
      },
    },
    run: async ({ camera, question }) => {
      const cam = CAMERAS[String(camera || "").toLowerCase()];
      if (!cam) return { ok: false, error: `no camera called "${camera}". Use desk or room.` };
      if (!(await visionReady())) {
        return {
          ok: false,
          error: `the vision model ${CONFIG.visionModel} is not pulled, so nothing can be looked at. ` +
                 `Run: ollama pull ${CONFIG.visionModel}`,
        };
      }
      let shot;
      try {
        shot = await grab(cam.url);
      } catch (e) {
        // Naming the camera matters: one of these being down is an ordinary
        // event and "I cannot see" without saying WHICH eye is unhelpful.
        return { ok: false, error: `could not get a frame from the ${camera} camera (${cam.what}): ${e.message}` };
      }
      const prompt = question
        ? `${DESCRIBE}\n\nThe specific question is: ${question}. Answer it from the picture alone; ` +
          "if the picture cannot answer it, say so."
        : DESCRIBE;
      try {
        const text = await see({ images: [shot.b64], prompt });
        /* RELAY, DO NOT EMBELLISH — and said here, in the result, because this
           is the sentence the model reads.

           Measured on the first working run: the camera reported "a laptop, a
           phone, and a black device with illuminated buttons", and the answer
           came back naming an MX Master 3, an iPhone 15 Pro Max, a notebook of
           half-written notes and coiled cables. None of that was in the
           picture. A camera that invents an iPhone is worse than no camera,
           because it is indistinguishable from one that works. */
        // A STRING, like every other tool here. Returned as an object, the loop
        // does String(result) and the model is handed "[object Object]" — it
        // then answered a question about the desk by inventing an MX Master 3,
        // an iPhone 15 Pro Max and a notebook of half-written notes, because
        // that is what a desk usually has. The camera worked perfectly; the
        // description never reached the model.
        return `Through the ${camera} camera (${cam.what}) right now:\n\n${text}\n\n` +
          "Report only what is written above. Do not name brands, models, colours or objects " +
          "that are not in it, and do not fill in what a desk like this usually has. If he asked " +
          "about something not mentioned, say it is not visible.";
      } catch (e) {
        return { ok: false, error: `the vision model failed: ${e.message}` };
      }
    },
  },
};
