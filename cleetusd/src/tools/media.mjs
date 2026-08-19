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

function py(args, ms) {
  return new Promise((resolve) => {
    execFile(PY, [SCRIPT, ...args], { timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000 },
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
        "needs a Hugging Face token this Mac does not have, so it will tell you so rather than run. " +
        "ASPECT matters: use 'portrait' or 'tall' for a person, 'landscape' or 'wide' for a scene. Square " +
        "is the default and is wrong for most photographs of people. " +
        "The FIRST use of a model downloads it (multi-GB) — if that is a concern, call list_media_models " +
        "first. Write a vivid, concrete prompt: subject, setting, lighting, style, lens. On the photoreal " +
        "models a photographic style is appended for you unless the prompt already names a style, so do not " +
        "pad it with 'photorealistic, 8k, masterpiece'. Do not claim an image exists until this returns a path.",
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
          out: { type: "string", description: "Output path. Omit to save a timestamped PNG in the media folder." },
        },
        required: ["prompt"],
      },
    },
    async run({ prompt, negative, model, aspect, steps, guidance, seed, out }) {
      if (!ready()) return ABSENT;
      const dest = out || `${OUT_DIR}/img_${stamp()}.png`;
      const args = ["image", "--prompt", String(prompt), "--out", dest];
      if (negative) args.push("--negative", String(negative));
      if (model) args.push("--model", String(model));
      if (aspect) args.push("--aspect", String(aspect));
      if (Number.isFinite(steps)) args.push("--steps", String(steps));
      if (Number.isFinite(guidance)) args.push("--guidance", String(guidance));
      if (Number.isFinite(seed)) args.push("--seed", String(seed));
      // Generous: the first call to a model downloads gigabytes, then generates.
      const r = await py(args, 20 * 60_000);
      if (!r.ok) return `Could not generate the image: ${r.error}`;
      // The seed is reported back deliberately: it is how a picture he liked
      // gets tweaked instead of replaced. Without it every "warmer light" is a
      // different photograph of a different person.
      return `Made a ${r.width}x${r.height} image with ${r.model} in ${r.seconds}s ` +
             `(${r.steps} steps, guidance ${r.guidance}` +
             `${r.seed != null ? `, seed ${r.seed}` : ""}). Saved to ${r.path}`;
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
          out: { type: "string", description: "Output MP4 path. Omit for a timestamped file in the media folder." },
        },
      },
    },
    async run({ prompt, image, mode, seconds, model, seed, out }) {
      if (!ready()) return ABSENT;
      if (!prompt && !image) return "Give me a prompt to make the keyframe from, or an image path to animate.";
      const dest = out || `${OUT_DIR}/vid_${stamp()}.mp4`;
      const args = ["video", "--out", dest, "--mode", mode || "motion"];
      if (prompt) args.push("--prompt", String(prompt));
      if (image) args.push("--image", String(image));
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
      return `Made a ${r.seconds}s pan-and-zoom video (${r.fps}fps) in ${r.render_seconds}s. ` +
             `Saved to ${r.path} (keyframe ${r.keyframe}). For genuine generative motion, ask for svd mode.`;
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
