// test/sampler.test.mjs — the model was being run with the wrong sampler.
//
// RealVisXL ships DDIMScheduler in its repo config, so that is what diffusers
// loads, and it is not what the fine-tune was made to be run with. Its own
// model card asks for DPM++ SDE Karras.
//
// Measured on the same seed, same prompt, same everything — "a close portrait
// of a bearded man…, freckles across the nose, sharp focus on the eyes":
//
//   DDIM               skin nearly smooth, the freckles the prompt asked for
//                      barely present, eyes soft
//   DPM++ SDE Karras   freckles across the nose and cheeks as asked, visible
//                      pores and colour variation, iris structure and
//                      catchlights, beard strands separating
//
// That is not only a quality difference, it is a PROMPT ADHERENCE difference:
// an element he explicitly asked for showed up in one and not the other. Which
// is the same complaint this whole area of the codebase exists to answer.
//
// Karras sigmas are the other half. They redistribute the noise schedule so
// more steps land where the image is actually being decided, which is what
// makes 30 steps behave like a much larger number.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "media_cli.py");
const cli = readFileSync(CLI, "utf8");
const PY = process.env.CLEETUSD_MEDIA_PYTHON || join(ROOT, "media/.venv/bin/python");

test("the guided models ask for the sampler they were tuned for", () => {
  const models = cli.slice(cli.indexOf("MODELS = {"), cli.indexOf("def enrich_prompt"));
  const realvis = models.slice(models.indexOf('"realvis"'), models.indexOf('"sdxl"'));
  assert.match(realvis, /"scheduler": "sde-dpmsolver\+\+"/,
    "realvis is back on whatever its repo config happens to ship");
  const sdxl = models.slice(models.indexOf('"sdxl"'), models.indexOf('"sdxl-turbo"'));
  assert.match(sdxl, /"scheduler": "dpmsolver\+\+"/);
});

test("the distilled models are left alone, because the scheduler IS the distillation", () => {
  // Swapping a turbo model's scheduler does not make it better. It makes it
  // wrong: the sampler is part of what was distilled into four steps. FLUX is
  // flow-matching and has nothing to do with any of this.
  const models = cli.slice(cli.indexOf("MODELS = {"), cli.indexOf("def enrich_prompt"));
  for (const [name, next] of [["sdxl-turbo", '"sd-turbo"'], ["sd-turbo", '"flux"'], ["flux", "}\n"]]) {
    const start = models.indexOf(`"${name}"`);
    const block = models.slice(start, next === "}\n" ? undefined : models.indexOf(next, start));
    assert.ok(!/"scheduler"/.test(block), `${name} had its scheduler swapped, which breaks it`);
  }
});

test("Karras sigmas are on, or half the benefit is missing", () => {
  const fn = cli.slice(cli.indexOf("def _retune_scheduler"), cli.indexOf("def _load_image_pipe"));
  assert.match(fn, /use_karras_sigmas=True/);
  assert.match(fn, /algorithm_type=want/, "every model would get the same algorithm");
  // from_config, not a fresh scheduler: the model's own beta schedule and
  // prediction type have to carry over or the output is nonsense.
  assert.match(fn, /DPMSolverMultistepScheduler\.from_config\(\s*\n?\s*pipe\.scheduler\.config/);
});

test("a scheduler that will not build does not cost a picture", () => {
  // The model's own default still produces an image. Failing the whole
  // generation because an optimisation could not be applied is the wrong
  // trade, and it would fail closed on exactly the machines least able to
  // afford a retry.
  const fn = cli.slice(cli.indexOf("def _retune_scheduler"), cli.indexOf("def _load_image_pipe"));
  assert.match(fn, /except Exception as exc:/);
  assert.match(fn, /return None/);
  assert.ok(!/raise/.test(fn), "it raises instead of falling back");
});

test("it says which sampler actually ran", { skip: !existsSync(PY) && "media venv is not installed" }, () => {
  // The whole reason this went unnoticed: nothing ever said. The log line
  // reported a load time and not what it had loaded.
  assert.match(cli, /sampling with \{tuned\}/);

  const r = execFileSync(PY, ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(CLI)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    // Built without loading any weights: a config is enough to prove the swap.
    "from diffusers import DDIMScheduler",
    "class P:",
    "    scheduler = DDIMScheduler(beta_schedule='scaled_linear')",
    "p = P()",
    "note = m._retune_scheduler(p, m.MODELS['realvis'])",
    "print(json.dumps({'note': note, 'now': type(p.scheduler).__name__,",
    "                  'karras': bool(p.scheduler.config.get('use_karras_sigmas')),",
    "                  'algo': p.scheduler.config.get('algorithm_type')}))",
  ].join("\n")], { encoding: "utf8", maxBuffer: 8_000_000 });

  const got = JSON.parse(r.trim().split("\n").pop());
  assert.equal(got.now, "DPMSolverMultistepScheduler", "the swap did not happen");
  assert.equal(got.karras, true);
  assert.equal(got.algo, "sde-dpmsolver++");
  assert.match(got.note, /Karras/);
});
