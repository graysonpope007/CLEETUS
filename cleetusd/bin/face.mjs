#!/usr/bin/env node
// bin/face.mjs — enrol and check faces by hand, without going through the model.
//
// Enrolment is the one part of this that a person has to be present for, and
// asking the assistant to do it means asking it at the exact moment you are
// looking at the camera rather than at the screen. This is the direct handle:
//   node bin/face.mjs learn Grayson
//   node bin/face.mjs who
//   node bin/face.mjs list
//   node bin/face.mjs forget Grayson
//
// It does not count down. The first version did, and a countdown takes its
// first shot while you are still reaching for the return key — so instead it
// watches until a face turns toward the lens and starts then.

import { faceRaw } from "../src/tools/faces.mjs";
import { CAMERAS } from "../src/tools/vision.mjs";

const [, , cmd = "who", ...rest] = process.argv;
const camName = (rest.find((a) => a.startsWith("--camera="))?.split("=")[1] || "room").toLowerCase();
const cam = CAMERAS[camName];
if (!cam) {
  console.error(`No camera called "${camName}". Use ${Object.keys(CAMERAS).join(" or ")}.`);
  process.exit(1);
}
const name = rest.filter((a) => !a.startsWith("--")).join(" ");

function show(r) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

switch (cmd) {
  case "learn": {
    if (!name) { console.error("Who? node bin/face.mjs learn Grayson"); process.exit(1); }
    console.log(`Look at the ${camName} camera (${cam.what}) some time in the next 40 seconds.`);
    console.log("It waits for a face turned toward it, then takes twelve shots — move your head a");
    console.log("little as it goes, small angles are what make it hold up later.");
    show(await faceRaw(["enroll", "--name", name, "--url", cam.url,
                        "--shots", "12", "--interval", "0.4", "--wait", "40"], 60_000));
  }
  case "who":
    show(await faceRaw(["identify", "--url", cam.url]));
  case "list":
    show(await faceRaw(["list"], 10_000));
  case "forget": {
    if (!name) { console.error("Forget whom? node bin/face.mjs forget Grayson"); process.exit(1); }
    show(await faceRaw(["forget", "--name", name], 10_000));
  }
  case "selftest":
    show(await faceRaw(["selftest", "--url", cam.url]));
  default:
    console.error("Usage: node bin/face.mjs learn <name> | who | list | forget <name> | selftest [--camera=room|desk]");
    process.exit(1);
}
