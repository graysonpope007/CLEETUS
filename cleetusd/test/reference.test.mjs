// test/reference.test.mjs — starting from a picture, and the black frame.
//
// Reference images are the biggest accuracy lever there is, for a reason that
// has nothing to do with prompting: some things cannot be said in words at
// all. The exact blue of a brand, the grain of a photograph he likes, a room's
// real proportions, the composition of a shot. He can describe those for a
// paragraph and still not get them, because the description is lossy and the
// file is not.
//
// THE BUG THIS SUITE EXISTS FOR came with the feature. The first reference
// image rendered pure black and the tool reported:
//
//   {"ok": true, "path": "...", "seed": 3, "seconds": 37.1}
//
// A path, a seed, a plausible duration, and no picture. That is the worst
// shape a fault can take here — not a crash, an assurance — and the agent
// would have gone on to tell him his picture was ready.
//
// Diagnosed rather than guessed. The VAE encode was clean, so the overflow was
// in the denoise, and the variable was attention slicing:
//
//   slicing on,  strength 0.55  ->  nan
//   slicing off, strength 0.55  ->  absmax 2.49
//   slicing off, strength 0.30  ->  absmax 2.44
//   slicing off, strength 0.90  ->  absmax 3.25
//
// Text-to-image with the same sliced UNet is fine, which is exactly why
// nothing caught it: every picture this file had ever made took the other path.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = process.env.CLEETUSD_MEDIA_PYTHON || join(ROOT, "media/.venv/bin/python");
const CLI = join(ROOT, "media_cli.py");
const cli = readFileSync(CLI, "utf8");
const mediaSrc = readFileSync(join(ROOT, "src/tools/media.mjs"), "utf8");
const dropsSrc = readFileSync(join(ROOT, "src/drops.mjs"), "utf8");

function inCli(snippet) {
  const prog = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("mcli", ${JSON.stringify(CLI)})`,
    "m = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(m)",
    snippet,
  ].join("\n");
  return JSON.parse(execFileSync(PY, ["-c", prog], { encoding: "utf8", maxBuffer: 8_000_000 }));
}
const havePy = existsSync(PY);

// ── the black frame ───────────────────────────────────────────────────────────

test("an all-black frame is a failure, never a success with a path on it", () => {
  // The guard is on the PIXELS, not on the cause. Attention slicing was this
  // overflow's source; the next one will have a different source and produce
  // exactly the same picture of nothing, and the honest thing to check is the
  // output rather than the list of causes known so far.
  const render = cli.slice(cli.indexOf("def _render"), cli.indexOf("def cmd_image"));
  assert.match(render, /image\.convert\("L"\)\.getextrema\(\)/,
    "nothing looks at the pixels before calling this a finished image");
  assert.match(render, /"ok": False/, "a black frame still returns ok");
  assert.match(render, /Nothing was saved/,
    "it must not leave a black file on disk for him to open");

  // And the check has to happen BEFORE the save, or the file exists anyway.
  assert.ok(render.indexOf("getextrema()") < render.indexOf("image.save(dest)"),
    "the black-frame check runs after the file has already been written");
});

test("the img2img pipe turns attention slicing off", () => {
  const fn = cli.slice(cli.indexOf("def _load_img2img_pipe"), cli.indexOf("def _load_reference"));
  assert.match(fn, /disable_attention_slicing\(\)/,
    "img2img is back on the sliced path that produces NaN on this GPU");
  // Text-to-image must KEEP it — that path is fine and slicing is what holds
  // peak memory down on the bigger models.
  const txt = cli.slice(cli.indexOf("def _load_image_pipe"), cli.indexOf("def _warn_if_truncated"));
  assert.match(txt, /enable_attention_slicing\(\)/,
    "text-to-image lost its slicing, which costs memory for no benefit");
});

// ── the reference itself ──────────────────────────────────────────────────────

test("a reference keeps its own shape rather than being stretched", { skip: !havePy && "media venv is not installed" }, () => {
  // A 4:5 reference squeezed into 16:9 changes every face and proportion in
  // it, which is the one thing a reference is for. Cover and centre-crop, the
  // way any layout tool would.
  const r = inCli(`
from PIL import Image
import tempfile, os
d = tempfile.mkdtemp()
wide = os.path.join(d, "wide.png"); Image.new("RGB", (1600, 900), (10, 120, 200)).save(wide)
tall = os.path.join(d, "tall.png"); Image.new("RGB", (900, 1600), (10, 120, 200)).save(tall)
import argparse
def dims(path):
    ns = argparse.Namespace(size=0, aspect="", reference=path)
    return list(m._dimensions(ns, m.MODELS["realvis"]))
print(json.dumps({
  "wide_aspect": m._reference_aspect(wide),
  "tall_aspect": m._reference_aspect(tall),
  "wide_dims": dims(wide),
  "tall_dims": dims(tall),
  # A wide picture fitted into a tall frame must come out the frame's size and
  # must not have been squashed to get there.
  "cover": list(m._load_reference(wide, 832, 1216).size),
  # An explicit aspect still wins over the reference's own shape.
  "explicit_wins": list(m._dimensions(argparse.Namespace(size=0, aspect="portrait", reference=wide), m.MODELS["realvis"])),
}))
`);
  // 1600x900 is 1.78, and the nearest shape this file can render is `wide`
  // (1344x768 = 1.75), not `landscape` (1216x832 = 1.46). Asserting
  // "landscape" here was the test paraphrasing the rule as "wide-ish pictures
  // are landscape" instead of checking the rule, which is nearest-ratio.
  assert.equal(r.wide_aspect, "wide");
  assert.equal(r.tall_aspect, "tall");
  assert.deepEqual(r.wide_dims, [1344, 768]);
  assert.deepEqual(r.cover, [832, 1216]);
  assert.deepEqual(r.explicit_wins, [832, 1216], "his explicit aspect lost to the reference's");
});

test("steps are scaled by strength, or a light touch is a mushy picture", () => {
  // diffusers starts the denoise partway along the schedule, so 30 steps at
  // strength 0.4 is twelve actual steps. A gentle grade would come back
  // blurrier than a heavy reinterpretation, which is exactly backwards.
  const render = cli.slice(cli.indexOf("def _render"), cli.indexOf("def cmd_image"));
  assert.match(render, /steps \/ max\(strength, 0\.15\)/,
    "steps are not scaled, so low strength silently under-denoises");
  assert.match(render, /min\(120, /, "the scaling has no ceiling");
});

test("a missing reference is refused before anything is loaded", () => {
  const render = cli.slice(cli.indexOf("def _render"), cli.indexOf("def cmd_image"));
  assert.match(render, /no such reference image/);
  assert.ok(render.indexOf("no such reference image") < render.indexOf("_load_img2img_pipe(model_key)"),
    "a typo in a path costs a multi-gigabyte model load before it is noticed");
});

test("strength is clamped rather than trusted", () => {
  // A 0 hands his own file back unchanged and reads as the generator being
  // broken; a 1.2 throws from inside the scheduler after the model has loaded.
  const render = cli.slice(cli.indexOf("def _render"), cli.indexOf("def cmd_image"));
  assert.match(render, /max\(0\.05, min\(1\.0, float\(strength\)\)\)/);
});

// ── the wiring ────────────────────────────────────────────────────────────────

test("the tool actually offers a reference, and says when it used one", () => {
  assert.match(mediaSrc, /reference: \{ type: "string"/, "the agent has no way to pass one");
  assert.match(mediaSrc, /strength: \{ type: "number"/);
  assert.match(mediaSrc, /args\.push\("--reference", String\(reference\)\)/,
    "the parameter exists but never reaches the sampler");
  assert.match(mediaSrc, /Started from \$\{r\.reference\}/,
    "using a reference is invisible in the answer he reads");
});

test("a dropped picture tells the agent it can be a reference", () => {
  // The two features are only worth as much as the join between them. Left to
  // itself the agent describes an attached picture back in words, which is the
  // lossy step the reference exists to remove.
  assert.match(dropsSrc, /pass this path to generate_image as its 'reference'/);
  assert.match(dropsSrc, /A description loses the exact colour, grain and composition/);
});
