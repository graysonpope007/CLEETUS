// src/tools/media.mjs — making pictures and video, on this Mac, from a sentence.
//
// The bridge to media_cli.py, the same shape as tracking.mjs and faces.mjs: a
// Python process does the heavy tensor work in its own venv, this file hands it
// arguments and reads back one JSON line. The venv is deliberately NOT the
// camera daemon's — diffusers drags in its own numpy and tokenizers, and
// upgrading those under a running MediaPipe pipeline is how you corrupt a live
// camera feed. So media generation gets an isolated ~/cleetusd/media/.venv and
// the studio work keeps its own.
//
// LOCAL IS THE WHOLE POINT. Every model runs on the M4 Max's GPU and no prompt
// or picture leaves the machine — the same bargain every other agent makes, for
// the same reason. It costs speed: the turbo models are seconds, full SDXL is
// minutes, and honest generative video (SVD) is minutes and a 10 GB download.
// The tools say which path ran and how long it took rather than hiding it.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { CONFIG } from "../config.mjs";
import { liftNegations } from "../literal.mjs";
import { inferAspect } from "../aspect.mjs";
import { get as getSecret } from "../keyring.mjs";
import { listReferences, referencesText, REFS_DIR } from "../refs.mjs";

// media_cli.py lives beside the daemon; its interpreter is the isolated media
// venv, overridable for a machine that keeps it elsewhere.
const PY = process.env.CLEETUSD_MEDIA_PYTHON || `${CONFIG.home}/cleetusd/media/.venv/bin/python`;
const SCRIPT = `${CONFIG.home}/cleetusd/media_cli.py`;
// Where finished pictures and clips land by default: a folder Grayson can open,
// not a temp dir that gets swept. Timestamped names keep a session's drafts
// side by side instead of overwriting one file.
const OUT_DIR = process.env.CLEETUSD_MEDIA_OUT || `${CONFIG.home}/cleetusd/media/out`;

const ABSENT =
  "Local media generation is not set up: its Python venv is missing " +
  "(~/cleetusd/media/.venv). Create it with the 3.12 interpreter and " +
  "`pip install torch diffusers transformers accelerate safetensors pillow`. " +
  "Everything runs on this Mac's GPU — do NOT claim an image was made until the tool returns a path.";

function stamp() {
  // No Date fields the model has to format — just enough to sort and not collide.
  return new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

/* ── The instruction to add a token was not true ─────────────────────────────
   media_cli.py refuses FLUX with "put HF_TOKEN in cleetus.env", and following
   that did nothing at all. cleetus.env is read into a local object to build
   CONFIG; it is never put into process.env, and execFile inherits process.env.
   So the token went in, the message stayed the same, and there was nothing to
   tell him why.

   That is worse than the whisper claim found an hour ago. That one only capped
   what the assistant would attempt. This one sends HIM to do something that
   cannot work, and then reports the same failure as if he had not done it.

   keyring.get() is the right door and already existed: it checks the keyring
   the deck writes to AND falls back to cleetus.env, so both places named in
   any message are genuinely covered by one lookup. */
async function hfEnv() {
  for (const name of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"]) {
    const found = await getSecret(name).catch(() => null);
    if (found?.value) return { HF_TOKEN: found.value, HUGGING_FACE_HUB_TOKEN: found.value };
  }
  return {};
}

async function py(args, ms) {
  const extra = await hfEnv();
  return new Promise((resolve) => {
    execFile(PY, [SCRIPT, ...args],
      { timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000,
        env: { ...process.env, ...extra } },
      (err, stdout, stderr) => {
        const raw = String(stdout || "").trim();
        if (raw) {
          // media_cli prints exactly one JSON line; progress goes to stderr.
          const last = raw.split("\n").pop();
          try { return resolve(JSON.parse(last)); } catch { /* fall through */ }
        }
        resolve({
          ok: false,
          error: err?.killed
            ? `generation did not finish in ${Math.round(ms / 1000)}s (a first-run model download or a heavy model can exceed this — try the models tool, or a turbo model)`
            : (String(stderr || err?.message || "no output").split("\n").pop() || "no output").slice(0, 300),
        });
      });
  });
}

function ready() {
  return existsSync(PY) && existsSync(SCRIPT);
}

export const mediaTools = {
  generate_image: {
    schema: {
      description:
        "Generate an image from a text prompt, entirely on this Mac's GPU (nothing leaves the machine). " +
        "Use when Grayson wants a picture, art, a mockup, a concept, a thumbnail, album art, a reference. " +
        "Returns the saved file path. " +
        "DEFAULT MODEL 'realvis' (RealVisXL) is a photorealistic model: about a minute an image, real skin " +
        "texture and lens character. Use it for anything meant to look like a photograph, which is most " +
        "requests. 'sdxl-turbo' is a three-second DRAFT — use it only when he is still deciding what he " +
        "wants, and say it is a draft. 'sdxl' is the general-purpose base. 'flux' is the best of them but " +
        "is the best of them but needs a Hugging Face token: it is Apache-2.0 but auto-gated, so an " +
        "account has to accept the terms once. If no token is present it says so rather than running. " +
        "Add it as HF_TOKEN on the Reach page (127.0.0.1:8767/reach) under Keys and secrets, or put it " +
        "in cleetus.env; both are read and both reach the sampler. " +
        "ASPECT matters: use 'portrait' or 'tall' for a person, 'landscape' or 'wide' for a scene. Square " +
        "is the default and is wrong for most photographs of people. " +
        "The FIRST use of a model downloads it (multi-GB) — if that is a concern, call list_media_models " +
        "first. Write a vivid, concrete prompt: subject, setting, lighting, style, lens. On the photoreal " +
        "models a photographic style is appended for you unless the prompt already names a style, so do not " +
        "pad it with 'photorealistic, 8k, masterpiece'. " +
        "REFERENCE: pass `reference` (a path to a picture on this Mac) to start from that image instead of " +
        "from noise. This is the strongest tool you have for accuracy, because some things cannot be said " +
        "in words at all — the exact blue of a brand, the grain of a photograph he likes, a room's real " +
        "proportions, the composition of a shot. WHENEVER he has attached a picture and is asking for " +
        "something like it, edited, restyled, in a different light, or 'more like this', USE IT as the " +
        "reference rather than trying to describe it back. `strength` is how far to travel from it: 0.25 is " +
        "a grade or a small edit, 0.55 is the same scene reinterpreted, 0.85 is loosely inspired by it. " +
        "The output takes the reference's own shape unless you set aspect. " +
        "Do not claim an image exists until this returns a path.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to draw — concrete and visual." },
          negative: { type: "string", description: "What to avoid. Ignored by the turbo models, which run without guidance; a sensible default is already applied on the others." },
          model: { type: "string", enum: ["realvis", "sdxl", "sdxl-turbo", "sd-turbo", "flux"], description: "Default realvis (photoreal). sdxl-turbo only for quick drafts." },
          aspect: { type: "string", enum: ["square", "portrait", "tall", "landscape", "wide"], description: "Shape of the image. Portrait/tall for a person, landscape/wide for a scene." },
          steps: { type: "number", description: "Denoising steps. Leave unset to use the model's tuned default." },
          guidance: { type: "number", description: "How hard to follow the prompt. Leave unset unless he asks for looser or tighter." },
          seed: { type: "number", description: "Set for a reproducible image; omit for a new one each time. Pass the SAME seed to tweak an image he liked." },
          reference: { type: "string", description: "Path to an image to start FROM instead of noise. Use whenever he attached a picture and wants something like it, edited, or restyled — it carries what words cannot." },
          strength: { type: "number", description: "Only with reference. How far to move from the reference, and it is the difference between editing his picture and replacing it. Take it from HIS WORDS. 'this exact photo but…', 'same shot', 'keep it, just…', a colour or light change, a small fix: 0.25-0.35. 'same scene', 'like this but different angle/season/weather': 0.5-0.6. 'inspired by', 'in this style', 'something like this': 0.8-0.9. Above 0.6 the people and the composition in his picture do NOT survive, so never use it for anything he called the same. Default 0.55." },
          out: { type: "string", description: "Output path. Omit to save a timestamped PNG in the media folder." },
        },
        required: ["prompt"],
      },
    },
    async run({ prompt, negative, model, aspect, steps, guidance, seed, out, reference, strength }) {
      if (!ready()) return ABSENT;
      const dest = out || `${OUT_DIR}/img_${stamp()}.png`;

      /* ── "no people" is a request for people ─────────────────────────────
         Cross-attention has no operator for "not". It has a vector for
         `people`, and "a quiet beach at sunrise, no people" reliably comes
         back with people on the beach — the prompt contradicted by its own
         picture. From outside that is indistinguishable from the model
         ignoring an instruction, which is a fair share of "it doesn't make
         what I ask for".

         Diffusion models have the other input for exactly this, so the
         negation is moved to where the sampler can act on it: out of the
         positive prompt, into the negative one. Done HERE rather than in the
         agent because every path ends at this function — the agent writing
         its own prompt, the forced generation pass, and the last-resort
         renderer all arrive through this one door, and a fix at the door
         cannot be routed around by adding a fourth. */
      const lifted = liftNegations(String(prompt));
      const promptUsed = lifted.terms.length ? lifted.cleaned : String(prompt);
      const negativeUsed = lifted.terms.length
        ? [String(negative || ""), ...lifted.terms].filter(Boolean).join(", ")
        : negative;

      /* ── Declining to choose a shape IS choosing square ──────────────────
         His brief says it twice: "Otherwise assume 4:5", and "square only when
         square is genuinely what it is for — square is the default and it is
         the wrong shape for most photographs of people." The code did the
         opposite: no --aspect meant 1024x1024.

         So the documented rule and the machine disagreed, and the machine won
         every time the model forgot the parameter — which bin/image-behaviour-
         check.mjs caught it doing twice in one evening.

         This is not a case for a firmer instruction. The instruction is
         already there and already emphatic. Forgetting should simply land on
         his stated default rather than on the shape he has twice written down
         as wrong.

         Skipped entirely when there is a reference: that picture's own shape
         is the answer, and media_cli takes it from the file. */
      const shape = (!aspect && !reference) ? inferAspect(promptUsed) : null;
      const aspectUsed = aspect || shape?.aspect || null;

      const args = ["image", "--prompt", promptUsed, "--out", dest];
      if (negativeUsed) args.push("--negative", String(negativeUsed));
      if (model) args.push("--model", String(model));
      if (aspectUsed) args.push("--aspect", String(aspectUsed));
      if (Number.isFinite(steps)) args.push("--steps", String(steps));
      if (Number.isFinite(guidance)) args.push("--guidance", String(guidance));
      if (Number.isFinite(seed)) args.push("--seed", String(seed));
      if (reference) args.push("--reference", String(reference));
      if (Number.isFinite(strength)) args.push("--strength", String(strength));
      // Generous: the first call to a model downloads gigabytes, then generates.
      const r = await py(args, 20 * 60_000);
      if (!r.ok) return `Could not generate the image: ${r.error}`;
      // The seed is reported back deliberately: it is how a picture he liked
      // gets tweaked instead of replaced. Without it every "warmer light" is a
      // different photograph of a different person.
      // If the prompt had to be encoded in more than one pass, say so. It used
      // to be a line on stderr nobody read, while the result said "Made a
      // 832x1216 image" — so a prompt whose last third never reached the
      // sampler was indistinguishable from one that did.
      const long = r.long_prompt ? ` Note: ${r.long_prompt}.` : "";
      // Said out loud, because it is a change to what he typed. Silent
      // helpfulness is the thing this whole area of the code is apologising for.
      const kept = lifted.terms.length
        ? ` Kept out via the negative prompt rather than the positive one, which a sampler reads backwards: ${lifted.terms.join(", ")}.`
        : "";
      // Said out loud, like the lifted negations. A silent crop is the most
      // visible unasked-for change there is.
      const shaped = shape
        ? ` He set no shape, so it was rendered ${shape.aspect} (${shape.why}) rather than square — say so, and offer another shape if that is wrong.`
        : "";
      const from = r.reference
        ? ` Started from ${r.reference} at strength ${r.strength} rather than from noise, so its composition and colour carry through.`
        : "";
      return `Made a ${r.width}x${r.height} image with ${r.model} in ${r.seconds}s ` +
             `(${r.steps} steps, guidance ${r.guidance}` +
             `${r.seed != null ? `, seed ${r.seed}` : ""}). Saved to ${r.path}${from}${shaped}${long}${kept}`;
    },
  },

  generate_video: {
    schema: {
      description:
        "Generate a short video on this Mac, nothing leaving the machine. Two modes. 'motion' (default) " +
        "makes a keyframe from your prompt and renders a real pan-and-zoom move over it with ffmpeg — a " +
        "shareable MP4 in seconds, always works; it is animated camera motion over one still, not novel " +
        "motion. 'svd' runs Stable Video Diffusion for genuine generative motion from the keyframe — much " +
        "heavier (a ~10GB model on first use, minutes to render on this GPU). Give a prompt to make the " +
        "keyframe, or pass an existing image. Returns the saved MP4 path. Say which mode you used and, for " +
        "svd, warn it will take a while.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Scene for the keyframe (or omit and pass image)." },
          image: { type: "string", description: "Path to an existing image to animate instead of generating one." },
          mode: { type: "string", enum: ["motion", "svd"], description: "Default 'motion' (fast). 'svd' = true generative motion, slow." },
          seconds: { type: "number", description: "Clip length target (default 4 for motion; svd is ~2-3s of frames)." },
          model: { type: "string", enum: ["sdxl-turbo", "sd-turbo", "sdxl"], description: "Keyframe model (default sdxl-turbo)." },
          seed: { type: "number", description: "Reproducible keyframe/motion." },
          aspect: { type: "string", enum: ["square", "portrait", "tall", "landscape", "wide"], description: "Shape of the clip. 'tall' for a story or a reel, 'wide' for a hero or YouTube, 'portrait' for a person. The video comes out the shape of its keyframe, so this decides both." },
          negative: { type: "string", description: "What to keep out of the keyframe, and therefore out of the clip." },
          out: { type: "string", description: "Output MP4 path. Omit for a timestamped file in the media folder." },
        },
      },
    },
    async run({ prompt, image, mode, seconds, model, seed, out, aspect, negative }) {
      if (!ready()) return ABSENT;
      if (!prompt && !image) return "Give me a prompt to make the keyframe from, or an image path to animate.";
      const dest = out || `${OUT_DIR}/vid_${stamp()}.mp4`;
      const args = ["video", "--out", dest, "--mode", mode || "motion"];
      /* A clip gets the same two guarantees a still does, for the same
         reasons. The keyframe is an image made by the same sampler, so a
         negation in the prompt puts the thing in the frame exactly as it does
         for a photograph — and the video then holds it for four seconds.

         The shape matters MORE here than for a still, because the clip comes
         out the shape of its keyframe: getting it wrong is a story that cannot
         go in a story, and there is no cropping it back afterwards without
         losing the move. Skipped when he is animating a picture he already
         has, whose shape is already decided. */
      const lifted = liftNegations(String(prompt || ""));
      const promptUsed = lifted.terms.length ? lifted.cleaned : String(prompt || "");
      const negativeUsed = lifted.terms.length
        ? [String(negative || ""), ...lifted.terms].filter(Boolean).join(", ")
        : negative;
      const shape = (!aspect && !image && promptUsed) ? inferAspect(promptUsed) : null;
      const aspectUsed = aspect || shape?.aspect || null;

      if (promptUsed) args.push("--prompt", promptUsed);
      if (image) args.push("--image", String(image));
      if (negativeUsed) args.push("--negative", String(negativeUsed));
      if (aspectUsed) args.push("--aspect", String(aspectUsed));
      if (model) args.push("--model", String(model));
      if (Number.isFinite(seconds)) args.push("--seconds", String(seconds));
      if (Number.isFinite(seed)) args.push("--seed", String(seed));
      // svd can download 10GB and denoise for minutes; motion is seconds.
      const r = await py(args, (mode === "svd" ? 30 : 15) * 60_000);
      if (!r.ok) return `Could not generate the video: ${r.error}`;
      if (r.mode === "svd") {
        return `Made a ${r.frames}-frame video with Stable Video Diffusion in ${r.seconds}s. ` +
               `Saved to ${r.path} (keyframe ${r.keyframe}).`;
      }
      const dims = r.width && r.height ? ` at ${r.width}x${r.height}` : "";
      const shaped = shape ? ` He set no shape, so it was made ${shape.aspect} (${shape.why}).` : "";
      const kept = lifted.terms.length
        ? ` Kept out via the negative prompt rather than the positive one: ${lifted.terms.join(", ")}.`
        : "";
      return `Made a ${r.seconds}s pan-and-zoom video (${r.fps}fps)${dims} in ${r.render_seconds}s. ` +
             `Saved to ${r.path} (keyframe ${r.keyframe}).${shaped}${kept} ` +
             `For genuine generative motion, ask for svd mode.`;
    },
  },

  list_references: {
    schema: {
      description:
        "List the reference pictures Grayson keeps for a brand, artist, project or look, so a " +
        "generation can START FROM his own artwork instead of from a description of it. " +
        "CALL THIS BEFORE generating anything for one of his brands or artists — GLM, Magnolia, " +
        "STEAP, Higher Ways, a specific artist, a venue — or any time he says 'like we usually do' " +
        "or 'in our style'. If a set matches, pass one of its paths to generate_image as `reference`, " +
        "and SAY which picture you started from. If nothing matches and the look matters, ask him " +
        "for two or three pictures rather than inventing a house style. " +
        "Do not go hunting the disk with find_files for logos and artwork: this is where they are.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const sets = await listReferences();
      return `Reference sets (${REFS_DIR}):\n${referencesText(sets)}`;
    },
  },

  list_media_models: {
    schema: {
      description:
        "Report which local image/video models are already downloaded on this Mac and which would need a " +
        "multi-GB download on first use, plus the GPU device in play. Call this before generating if avoiding " +
        "a long first-run download matters, or when Grayson asks what can run locally.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      if (!ready()) return ABSENT;
      const r = await py(["models"], 60_000);
      if (!r.ok) return `Could not read the model state: ${r.error}`;
      const im = Object.entries(r.image_models)
        .map(([k, v]) => `- ${k}: ${v.downloaded ? "downloaded" : "not yet (downloads on first use)"} (${v.repo})`)
        .join("\n");
      return `Generating on ${r.device} (${r.dtype}). Default image model ${r.default_image}, ` +
             `default video mode ${r.default_video_mode}.\n\nImage models:\n${im}\n\n` +
             `Video (SVD, genuine motion): ${r.svd.downloaded ? "downloaded" : "not yet — ~10GB on first use"}.`;
    },
  },
};
