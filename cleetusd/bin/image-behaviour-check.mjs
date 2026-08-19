#!/usr/bin/env node
// bin/image-behaviour-check.mjs — does the image agent actually DO it?
//
//   node bin/image-behaviour-check.mjs
//
// WHY THIS EXISTS SEPARATELY FROM test/
// Everything the last several commits added is plumbing, and plumbing is not
// behaviour. generate_image has taken a `reference` since it was written; the
// question that matters is whether the model REACHES for it when Grayson hands
// it a picture, and no amount of asserting on source text answers that. The
// unit tests can prove the parameter exists and the brief mentions it. Only
// running the real ask() against the real local model proves it gets used.
//
// It is not in `node --test` because it needs ollama and takes minutes — the
// same reason routing-check.mjs lives here. Run it after touching the image
// brief, literal.mjs, the media tool, or anything in agent.mjs's image path.
//
// WHAT IS STUBBED, AND WHAT IS NOT
// The MODEL is real. The SAMPLER is not: CLEETUSD_MEDIA_PYTHON is pointed at a
// shell script that records the arguments it was handed and prints the JSON
// line media_cli.py would print. A minute of GPU per case would make this too
// slow to run, and the picture is not what is being tested. The arguments are —
// did it pass --reference, what went in --prompt, what went in --negative.
//
// A FAILURE HERE IS REAL. These three cases are the three complaints this
// whole area of the codebase exists to answer: it described my picture instead
// of using it, it put in the thing I said to leave out, and it embroidered
// what I told it exactly.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "imgcheck-"));
const LOG = join(dir, "calls.log");
const STUB = join(dir, "fake-python.sh");

writeFileSync(STUB, `#!/bin/sh
printf '%s\\0' "$@" >> "${LOG}"
printf '\\n---\\n' >> "${LOG}"
for a in "$@"; do
  case "$prev" in --out) OUT="$a" ;; esac
  prev="$a"
done
[ -n "$OUT" ] && : > "$OUT"
echo '{"ok": true, "kind": "image", "path": "'"\${OUT:-/tmp/stub.png}"'", "model": "realvis", "steps": 30, "width": 832, "height": 1216, "guidance": 4.5, "negative_applied": true, "prompt_used": "stubbed", "long_prompt": null, "seed": 424242, "seconds": 0.1, "reference": null, "strength": null}'
`);
chmodSync(STUB, 0o755);
process.env.CLEETUSD_MEDIA_PYTHON = STUB;

/* ── This check must not write into the real media folder ────────────────────
   The stub truncates whatever --out it is handed, and the agent defaults that
   to ~/cleetusd/media/out. Three runs of this file left twenty-two zero-byte
   PNGs sitting in with his actual pictures — invisible in a listing, and each
   one a broken image in the chat window when anything tried to show it.

   That is how it was found, in fact: the deck's new inline media rendering
   silently dropped one of two pictures, and the missing one was a corpse this
   very script had left there an hour earlier. A test that litters the thing it
   is testing eventually gets mistaken for the bug.

   Set BEFORE the media tool is imported, because it reads the path once at
   module load. */
process.env.CLEETUSD_MEDIA_OUT = join(dir, "out");
mkdirSync(process.env.CLEETUSD_MEDIA_OUT, { recursive: true });

/* A reference set of its own, so case 5 has something to find and his real
   media/refs is never read. Two pictures, because one would let a lucky guess
   at a filename pass for having looked. */
process.env.CLEETUSD_REFS_DIR = join(dir, "refs");
mkdirSync(join(process.env.CLEETUSD_REFS_DIR, "glm"), { recursive: true });
for (const f of ["sky-ciela-cover.png", "last-single.png"]) {
  writeFileSync(join(process.env.CLEETUSD_REFS_DIR, "glm", f), "x");
}

writeFileSync(LOG, "");

// Imported AFTER the stub is in place: the media tool reads the interpreter
// path at module load, so importing first would pin the real venv and every
// case would spend a minute on the GPU.
const { ask } = await import("../src/agent.mjs");

const REFERENCE = process.env.IMAGE_CHECK_REFERENCE ||
  join(ROOT, "media/out/woman-gym-workout.png");

function calls() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n---\n").filter((s) => s.trim())
    .map((chunk) => chunk.split("\0").filter(Boolean));
}
const argOf = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
};

let lastAnswer = "";
let toolsCalled = [];
async function run(label, message) {
  writeFileSync(LOG, "");
  toolsCalled = [];
  const t0 = Date.now();
  // probe:true so a benchmark run is never read back later as something
  // Grayson actually asked for.
  //
  // onStep is how a tool that never reaches the SAMPLER becomes observable.
  // The first version of case 5 asserted on the answer text instead, and
  // "it looked at his reference sets" passed because the answer contained the
  // word GLM — which the request also contains. A check that passes for the
  // wrong reason is worse than no check, and it is the same trap as a green
  // test that never ran.
  const out = await ask({ history: [{ role: "user", content: message }], agent: "image",
                          probe: true, maxSteps: 8,
                          onStep: ({ tool }) => toolsCalled.push(tool) });
  lastAnswer = String(out.answer || "");
  const argv = calls();
  console.log(`\n### ${label}  (${Math.round((Date.now() - t0) / 1000)}s, ${argv.length} tool call(s))`);
  console.log(`    ${String(out.answer || "(nothing)").replace(/\s+/g, " ").slice(0, 160)}`);
  for (const a of argv) {
    console.log("    ->", JSON.stringify({
      prompt: (argOf(a, "--prompt") || "").slice(0, 150),
      reference: argOf(a, "--reference"), strength: argOf(a, "--strength"),
      aspect: argOf(a, "--aspect"), negative: (argOf(a, "--negative") || "").slice(0, 60),
    }));
  }
  return argv;
}

// ── 1. "It described my picture instead of using it" ─────────────────────────
{
  const argv = await run("a picture in hand, asked for a variation",
    `make this same shot but at golden hour\n\n[Grayson attached gym.png (image, 1.2 MB). ` +
    `It is on disk at ${REFERENCE} — use that path with read_file, the shell, ffmpeg or the editor.] ` +
    `[If he is asking for a picture LIKE this one, edited, restyled or in a different light, pass this ` +
    `path to generate_image as its 'reference' rather than describing it back in words. A description ` +
    `loses the exact colour, grain and composition; the file does not.]`);
  const used = argv.find((a) => argOf(a, "--reference"));
  check("passed the attached picture as a reference", !!used,
    used ? `reference=${argOf(used, "--reference")} strength=${argOf(used, "--strength")}`
         : "no --reference in any call, so it described the picture instead of using it");

  /* Strength is the difference between editing his picture and replacing it,
     and the model was picking it inconsistently: 0.25 on one run of this exact
     case and 0.85 on the next. He said "this SAME shot", and above about 0.6
     the person in his photograph does not survive — so the high roll quietly
     hands back a different woman in a different gym and calls it his picture.

     Asserted as a ceiling rather than a value, because 0.25 and 0.4 are both
     defensible for a relight and only the top of the range is wrong. */
  if (used) {
    const s = Number(argOf(used, "--strength"));
    check("kept the strength low enough that his picture survives",
      Number.isFinite(s) && s <= 0.6,
      `strength=${s} — he said "same shot", and above 0.6 the reference stops being the same photograph`);
  }
}

// ── 2. "It put in the thing I said to leave out" ─────────────────────────────
{
  const argv = await run("a negation in the request",
    "make me a photo of an empty beach at sunrise, no people");
  const call = argv[0];
  if (!call) check("generated at all", false, "no tool call");
  else {
    check("the excluded thing is not in the positive prompt",
      !/\bpeople\b/i.test(argOf(call, "--prompt") || ""), `prompt: ${(argOf(call, "--prompt") || "").slice(0, 120)}`);
    check("the exclusion reached the negative prompt",
      /people/i.test(argOf(call, "--negative") || ""), `negative: ${(argOf(call, "--negative") || "(empty)").slice(0, 80)}`);

    /* The negative prompt is a place to invent, and it is the one nobody looks
       at. Asked for "an empty beach at sunrise, no people", this wrote
       "people, figures, boats, footprints, litter, CLOUDS" — and a sunrise
       with no clouds is a different photograph that he would never have found
       the reason for.

       Only the harmful class is asserted. Synonyms of what he DID exclude
       ("figures", "crowds") are the model doing its job, and boats on an
       "empty" beach are defensible. Weather and light are not: he said nothing
       about them, and excluding them silently changes the picture. */
    const negative = (argOf(call, "--negative") || "").toLowerCase();
    const weather = ["cloud", "fog", "mist", "rain", "haze", "overcast", "sun ", "sunlight", "shadow"]
      .filter((w) => negative.includes(w));
    check("it invented no weather or light exclusions of its own", weather.length === 0,
      weather.length ? `excluded without being asked: ${weather.join(", ")} — in "${negative}"` : "clean");
  }
}

// ── 3. "It embroidered what I told it exactly" ───────────────────────────────
{
  const argv = await run("an exact instruction",
    'use this exact prompt, nothing added: "a single red cube on a white background"');
  const call = argv[0];
  if (!call) check("generated at all", false, "no tool call");
  else {
    const prompt = (argOf(call, "--prompt") || "").toLowerCase();
    check("used his words", /red cube/.test(prompt) && /white background/.test(prompt), prompt.slice(0, 140));
    // The tell for embroidery is vocabulary nobody asked for. Kept to words
    // that could not plausibly be his, so a fail here is a real fail.
    const invented = ["studio", "lighting", "shadow", "reflect", "dramatic", "cinematic", "8k",
                      "hyperdetailed", "professional", "minimalist", "depth of field", "bokeh"]
      .filter((w) => prompt.includes(w));
    check("added nothing of its own", invented.length === 0,
      invented.length ? `invented: ${invented.join(", ")}` : "clean");
  }
}

// ── 4. "It gave me a different picture instead of changing that one" ─────────
{
  /* The reason the seed is reported back at all. A tweak is supposed to be a
     tweak: same seed, one thing changed. Re-roll it and "warmer light" comes
     back as a different photograph of a different person, which is the most
     infuriating version of not-what-I-asked-for because the first one was
     right.

     The seed is sitting in the conversation — the previous tool result said
     it in words. The question is whether the model reaches back for it. */
  const argv = await run("a tweak to a picture he already has",
    "that's the one, but warmer light\n\n[Earlier this turn you made: Made a 832x1216 image with " +
    "realvis in 41.2s (30 steps, guidance 4.5, seed 771144). Saved to " +
    "/Users/grayson/cleetusd/media/out/img_20260819_bassist.png]");
  const call = argv[0];
  if (!call) check("generated at all", false, "no tool call");
  else {
    const seed = argOf(call, "--seed");
    check("reused the seed instead of rolling a new picture", seed === "771144",
      seed ? `--seed ${seed}, and his was 771144` :
             "no --seed at all, so 'warmer light' returns a different person entirely");
  }
}

// ── 5. "It invented a house style instead of using ours" ────────────────────
{
  /* The tool is plumbing until the habit forms. list_references exists and the
     brief mentions it; the question is whether a request naming one of his
     brands makes the agent LOOK before it styles.

     The old behaviour was find_files across his home directory, and when that
     turned up nothing — which was most of the time — the fallback was
     inventing a house style. That is the most expensive kind of wrong answer
     here, because it is competent and confident and looks like nothing in
     particular. */
  const argv = await run("a request naming one of his brands",
    "make a cover for the next GLM single, in our usual style");
  const looked = calls().length === 0;  // list_references does not touch the sampler
  const gen = argv.find((a) => argOf(a, "--prompt"));
  // The tool call itself is invisible in the sampler log, so the evidence is
  // in the ANSWER: it should name the set or the picture it started from.
  check("it called list_references before styling", toolsCalled.includes("list_references"),
    `tools called: ${toolsCalled.join(", ") || "(none)"}`);
  if (gen) {
    const ref = argOf(gen, "--reference");
    check("and started from one of his pictures", !!ref && ref.includes("refs/"),
      ref ? `reference=${ref}` : "no --reference, so it invented a look rather than using his");
  }
  void looked;
  check("and did not spend the whole budget re-rolling", argv.length <= 3,
    `${argv.length} generate calls for one request`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
