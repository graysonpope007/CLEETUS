// Face recognition, tested for the thing that would actually go wrong.
//
// "It recognises Grayson" needs Grayson in front of a camera and is therefore
// not a test, it is a demo. The failure worth guarding is the opposite one: a
// face that is NOT recognised coming back with a name on it anyway, because
// that is the failure the whole tool exists to prevent and the one nobody would
// notice — a confident wrong name reads exactly like a right one.
//
// So these assert the refusals: below threshold is nameless, too far away is
// nameless, an empty gallery names nobody, and every path says so in words the
// model cannot mistake for a match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOLS, toolSchemas, callTool } from "../src/tools/index.mjs";
import { CAMERAS } from "../src/tools/vision.mjs";

test("the face tools are registered and reach the model", () => {
  for (const name of ["who_is_there", "learn_face", "known_faces"]) {
    assert.ok(TOOLS[name], `${name} missing from the registry`);
    assert.ok(toolSchemas().find((t) => t.function.name === name),
      `${name} is not in the schemas handed to Ollama`);
  }
});

test("who_is_there is described in the words he would actually use", () => {
  const d = TOOLS.who_is_there.schema.description.toLowerCase();
  for (const phrase of ["who is at my desk", "who is in the room", "am i in frame", "recognise"]) {
    assert.ok(d.includes(phrase), `description should cover "${phrase}"`);
  }
  // The routing hazard: `look` can describe a face beautifully and then invent
  // whose it is. The description has to send that question here instead.
  assert.match(TOOLS.who_is_there.schema.description, /'look' only describes/);
});

test("known_faces forbids answering from memory, in the description", () => {
  // MEASURED, and the reason this test exists. Asked "do you know what I look
  // like?", it called nothing and answered that it had learned his face "from
  // our earlier conversations" and that the overhead desk camera "has a clear
  // view of you" — a camera that points straight down and has never once seen
  // a face. Both inventions, both confident, no tool call anywhere in the run.
  //
  // Whether a face is enrolled is a fact on disk that changes. The description
  // has to say the model cannot know it, or the model assumes it does.
  const d = TOOLS.known_faces.schema.description;
  assert.match(d, /BEFORE answering/);
  for (const phrase of ["do you know what I look like", "do you recognise me"]) {
    assert.ok(d.includes(phrase), `description should catch "${phrase}"`);
  }
  assert.match(d, /cannot answer these from memory/i);
});

test("learn_face without a name is refused before the camera runs", async () => {
  const out = await callTool("learn_face", {});
  assert.match(out, /missing a required argument/);
  assert.doesNotMatch(out, /learned|saved/i, "must not read as though anything was enrolled");
});

test("the aliases point at the real tools", async () => {
  const src = await readFile(join(import.meta.dirname, "../src/tools/index.mjs"), "utf8");
  for (const alias of ["who", "whos_there", "identify_face", "recognize_face", "remember_face"]) {
    assert.match(src, new RegExp(`\\b${alias}: "(who_is_there|learn_face)"`), `${alias} is not aliased`);
  }
});

test("both face tools look through the SAME camera map as the eyes", async () => {
  // Two copies of these URLs is two things to keep in step with the hardware,
  // and the one that drifts is the one nobody is looking at.
  const src = await readFile(join(import.meta.dirname, "../src/tools/faces.mjs"), "utf8");
  assert.match(src, /import \{ CAMERAS \} from "\.\/vision\.mjs"/);
  assert.doesNotMatch(src, /127\.0\.0\.1:87\d\d/, "faces.mjs must not hardcode a camera URL");
  assert.ok(CAMERAS.room?.url && CAMERAS.desk?.url);
});

test("an unknown camera is refused by name", async () => {
  for (const tool of ["who_is_there"]) {
    const out = await callTool(tool, { camera: "kitchen" });
    assert.match(out, /No camera called "kitchen"/);
  }
});

// ── the part that matters: the recogniser's own refusals ────────────────────

test("the threshold is the measured one, not the shipped one, and lives in one place", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  // SFace ships 0.363. At 0.363 a stranger in ~/Desktop/Oak hill/IMG_1340.jpg —
  // same colouring, same curly fair hair — scored 0.394 against Grayson's
  // gallery and would have been called Grayson by name.
  assert.match(py, /COSINE_MATCH = 0\.45/);
  assert.match(py, /0\.394/, "the impostor score that moved the threshold must stay written down");
  assert.match(py, /min 0\.634/, "so must the true-match floor it was set against");
  // A second literal threshold somewhere is how a hand-tuned "just this once"
  // loosening survives review. argparse defaults must reference the constant.
  assert.match(py, /default=COSINE_MATCH/);
  assert.equal((py.match(/COSINE_MATCH = /g) || []).length, 1);
});

test("a face too small to measure is never given a name", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  // Reported, not dropped, and reported WITHOUT a name or a score.
  assert.match(py, /"name": None, "score": None, "too_small": True/);
});

test("a name is attached only above the threshold", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  assert.match(py, /entry\["name"\] = best_name if \(known and best_score >= args\.threshold\) else None/);
});

test("enrolment refuses a set of shots that disagree with each other", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  // The room camera has held three people at once. Enrolment takes the largest
  // face, so someone crossing in front mid-capture would be saved as Grayson.
  assert.match(py, /shots_disagree/);
  assert.match(py, /Nothing was saved/);
});

test("enrolment refuses to bank the same pose twice", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  // Measured on this camera: the same man at different head angles scored 0.225
  // against himself, under the 0.363 needed to match. What makes a gallery work
  // is the spread of poses in it, so twelve frames half a second apart — one
  // pose twelve times — is a gallery that fails the moment he tilts his head.
  assert.match(py, /DIVERSITY_MAX = 0\.97/);
  assert.match(py, /max\(cosine\(v, u\) for u in vecs\) > DIVERSITY_MAX/);
});

test("the frozen-camera warning looks where the evidence moved to", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  // It used to detect a stuck camera by near-identical SHOTS. The diversity
  // gate now rejects those before they are ever kept, so that detector could
  // never fire again — it would have sat there reading as a live check.
  assert.match(py, /"frozen_frame_suspected": bool\(tally\(rejected\)\["same_pose"\] >= 10/);
});

test("the frontality gate is set from measurements, not taste", async () => {
  const py = await readFile(join(import.meta.dirname, "../face_cli.py"), "utf8");
  assert.match(py, /MAX_NOSE_OFFSET = 0\.30/);
  assert.match(py, /MIN_EYE_SPREAD = 0\.30/);
  // The numbers those thresholds sit between, kept next to them. A gate whose
  // first setting rejected every frame it was shown is a gate that needs its
  // evidence written down.
  assert.match(py, /0\.245 and 0\.423/);
  assert.match(py, /0\.086/);
});

test("the relay rule is in the RESULT, not only in the prompt", async () => {
  const src = await readFile(join(import.meta.dirname, "../src/tools/faces.mjs"), "utf8");
  // `look` was handed a description and answered with an iPhone that did not
  // exist. The same model, handed "one unrecognised face", will supply a name
  // unless the result itself forbids it — and the result is what it reads last.
  assert.match(src, /Do not put a name on a face reported as unrecognised/);
  assert.match(src, /RELAY/);
});

test("no faces and no camera are different answers", async () => {
  const src = await readFile(join(import.meta.dirname, "../src/tools/faces.mjs"), "utf8");
  assert.match(src, /camera_down/);
  assert.match(src, /no face at all in the frame/);
  // "I can't see anyone" for a dead camera is the lie that makes an empty room
  // and a broken camera the same sentence.
  assert.doesNotMatch(src, /case "camera_down":\s*\n\s*return "nobody/i);
});
