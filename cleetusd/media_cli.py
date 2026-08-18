#!/usr/bin/env python3
"""media_cli.py — image and video generation, entirely on this Mac.

WHY LOCAL, AND WHY THAT COSTS SOMETHING
Every other agent in Cleetus runs on the local model for one reason: a personal
assistant that phones a vendor with Grayson's face, his body-fat trend or his
half-finished ideas is not private. Image generation is the same bargain. A
prompt is a thought, and the drafts are things he has not decided to show
anyone. So this runs the diffusion on the M4 Max's GPU (MPS) and nothing — not
the prompt, not the picture — leaves the machine.

The cost is honest and worth stating: local means slower than a hosted H100 and
capped by 128 GB of unified memory, not a datacentre. SDXL is minutes on MPS;
the turbo models are seconds. Video is the hard part — true generative video
diffusion (Stable Video Diffusion) runs here but is heavy, so there are two
paths and the command says which it used.

THE MODELS, chosen for this machine
  sdxl-turbo   default. ~1-4 steps, guidance off, seconds per image on MPS,
               1024-ish quality. The right default for "make me an image".
  sd-turbo     smaller and faster still, 512px. The fallback when sdxl-turbo is
               not yet downloaded and speed matters more than resolution.
  sdxl         full SDXL base. Minutes on MPS, best quality. Opt-in, not default.
Nothing is bundled. Each model downloads from Hugging Face on first use into the
usual HF cache and is reused forever after; `models` reports what is already here
so a request can avoid a multi-GB wait it did not ask for.

VIDEO
  motion  (default) generate a keyframe, then a real pan-and-zoom move rendered
          with ffmpeg. Always runs, no extra model, produces an MP4 in seconds.
          Honest name: it is animated, not generated frame-by-frame.
  svd     Stable Video Diffusion img2vid. Actual generative motion, ~14-25
          frames from a keyframe. Heavy (~10 GB model, minutes on MPS), opt-in.

Everything prints ONE json object on stdout so the Node side parses a result
rather than scraping text. Progress and model chatter go to stderr.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Keep HF from phoning home for telemetry, and let the big first-download show
# progress on stderr rather than looking hung.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODELS = {
    "sdxl-turbo": {"repo": "stabilityai/sdxl-turbo", "steps": 3, "guidance": 0.0, "size": 1024},
    "sd-turbo":   {"repo": "stabilityai/sd-turbo",   "steps": 2, "guidance": 0.0, "size": 512},
    "sdxl":       {"repo": "stabilityai/stable-diffusion-xl-base-1.0", "steps": 30, "guidance": 7.0, "size": 1024},
}
SVD_REPO = "stabilityai/stable-video-diffusion-img2vid-xt"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def out(obj):
    """The one line of stdout the Node side reads."""
    print(json.dumps(obj))
    sys.exit(0 if obj.get("ok") else 1)


def _device_and_dtype():
    import torch
    if torch.backends.mps.is_available():
        return "mps", torch.float16
    if torch.cuda.is_available():
        return "cuda", torch.float16
    return "cpu", torch.float32


def _hf_cache_has(repo: str) -> bool:
    """Is this model already downloaded? Lets a request decline a multi-GB wait."""
    try:
        from huggingface_hub import scan_cache_dir
        wanted = repo.lower()
        for r in scan_cache_dir().repos:
            if r.repo_id.lower() == wanted:
                return True
    except Exception:
        pass
    return False


# ── image ────────────────────────────────────────────────────────────────────
_PIPE_CACHE = {}


def _load_image_pipe(model_key: str):
    if model_key in _PIPE_CACHE:
        return _PIPE_CACHE[model_key]
    import torch
    from diffusers import AutoPipelineForText2Image

    spec = MODELS[model_key]
    device, dtype = _device_and_dtype()
    log(f"[media] loading {spec['repo']} on {device} ({dtype})")
    t0 = time.time()
    # Some repos ship an fp16 variant, some do not. Ask for it, and fall back to
    # the default weights rather than dying when a repo has only one precision.
    try:
        pipe = AutoPipelineForText2Image.from_pretrained(
            spec["repo"], torch_dtype=dtype,
            variant="fp16" if dtype == torch.float16 else None, use_safetensors=True)
    except Exception as exc:
        log(f"[media] fp16 variant unavailable ({exc}); loading default weights")
        pipe = AutoPipelineForText2Image.from_pretrained(
            spec["repo"], torch_dtype=dtype, use_safetensors=True)
    pipe = pipe.to(device)
    # MPS has no benefit from attention slicing off, and slicing keeps peak
    # memory in check on the bigger models.
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    log(f"[media] pipe ready in {time.time() - t0:.1f}s")
    _PIPE_CACHE[model_key] = pipe
    return pipe


def cmd_image(args):
    import torch

    model_key = args.model if args.model in MODELS else "sdxl-turbo"
    spec = MODELS[model_key]
    steps = args.steps or spec["steps"]
    size = args.size or spec["size"]

    if not args.prompt:
        out({"ok": False, "error": "no prompt"})

    pipe = _load_image_pipe(model_key)
    gen = None
    if args.seed is not None:
        device, _ = _device_and_dtype()
        # MPS generators exist but the reproducible path everyone relies on is a
        # CPU generator; the small transfer is free next to the denoise.
        gen = torch.Generator(device="cpu").manual_seed(int(args.seed))

    log(f"[media] generating {size}px, {steps} steps, guidance {spec['guidance']}")
    t0 = time.time()
    image = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative or None,
        num_inference_steps=steps,
        guidance_scale=spec["guidance"],
        height=size, width=size,
        generator=gen,
    ).images[0]
    dt = time.time() - t0

    dest = Path(args.out).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)
    out({"ok": True, "kind": "image", "path": str(dest), "model": model_key,
         "steps": steps, "size": size, "seed": args.seed, "seconds": round(dt, 1)})


# ── video ─────────────────────────────────────────────────────────────────────
def _ffmpeg() -> str:
    for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"):
        if p == "ffmpeg" or Path(p).exists():
            return p
    return "ffmpeg"


def cmd_video(args):
    if not args.prompt and not args.image:
        out({"ok": False, "error": "video needs a --prompt to make a keyframe, or an --image"})

    # A keyframe first: either given, or generated locally like any other image.
    keyframe = args.image
    if not keyframe:
        tmp = Path(args.out).expanduser().with_suffix(".keyframe.png")
        ns = argparse.Namespace(prompt=args.prompt, negative=args.negative,
                                model=args.model, steps=args.steps, size=None,
                                seed=args.seed, out=str(tmp))
        # Reuse the image path but do not let it exit the process.
        try:
            _gen_keyframe(ns)
            keyframe = str(tmp)
        except SystemExit:
            keyframe = str(tmp)

    if args.mode == "svd":
        return _video_svd(args, keyframe)
    return _video_motion(args, keyframe)


def _gen_keyframe(ns):
    """cmd_image without the process exit — for the video keyframe."""
    import torch
    model_key = ns.model if ns.model in MODELS else "sdxl-turbo"
    spec = MODELS[model_key]
    pipe = _load_image_pipe(model_key)
    gen = torch.Generator(device="cpu").manual_seed(int(ns.seed)) if ns.seed is not None else None
    image = pipe(prompt=ns.prompt, negative_prompt=ns.negative or None,
                 num_inference_steps=ns.steps or spec["steps"],
                 guidance_scale=spec["guidance"], height=spec["size"], width=spec["size"],
                 generator=gen).images[0]
    dest = Path(ns.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)


def _video_motion(args, keyframe):
    """A real pan-and-zoom move over the keyframe, rendered by ffmpeg.

    Honest about what it is: the frames are interpolated camera motion over one
    generated still, not diffusion per frame. It always runs, needs no second
    model, and produces a shareable MP4 in seconds — the right default when the
    ask is "make me a short video" rather than "generate novel motion".
    """
    seconds = max(1, int(args.seconds or 4))
    fps = 30
    frames = seconds * fps
    dest = Path(args.out).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Zoompan over the still: a slow push-in with a gentle drift. The scale up
    # front is what stops zoompan's single-pixel-per-frame jitter.
    zoom = "zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" \
           f":d={frames}:s=1024x1024:fps={fps}"
    cmd = [_ffmpeg(), "-y", "-loglevel", "error", "-loop", "1", "-i", keyframe,
           "-vf", f"scale=2048:2048,{zoom},format=yuv420p", "-t", str(seconds),
           "-c:v", "libx264", "-preset", "medium", "-movflags", "+faststart", str(dest)]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        out({"ok": False, "error": f"ffmpeg failed: {r.stderr[-400:]}", "keyframe": keyframe})
    out({"ok": True, "kind": "video", "mode": "motion", "path": str(dest),
         "keyframe": keyframe, "seconds": seconds, "fps": fps,
         "render_seconds": round(time.time() - t0, 1)})


def _video_svd(args, keyframe):
    """Stable Video Diffusion img2vid — genuine generative motion, heavy."""
    import torch
    from diffusers import StableVideoDiffusionPipeline
    from diffusers.utils import export_to_video
    from PIL import Image

    device, dtype = _device_and_dtype()
    log(f"[media] loading SVD ({SVD_REPO}) on {device} — this is the heavy path")
    pipe = StableVideoDiffusionPipeline.from_pretrained(
        SVD_REPO, torch_dtype=dtype, variant="fp16" if dtype == torch.float16 else None)
    pipe = pipe.to(device)
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass

    img = Image.open(keyframe).convert("RGB").resize((1024, 576))
    gen = torch.Generator(device="cpu").manual_seed(int(args.seed)) if args.seed is not None else None
    n = max(14, min(int((args.seconds or 2) * 7), 25))
    log(f"[media] denoising {n} frames — minutes on MPS")
    t0 = time.time()
    frames = pipe(img, decode_chunk_size=4, num_frames=n, generator=gen).frames[0]
    dest = Path(args.out).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    export_to_video(frames, str(dest), fps=7)
    out({"ok": True, "kind": "video", "mode": "svd", "path": str(dest),
         "keyframe": keyframe, "frames": n, "seconds": round(time.time() - t0, 1)})


# ── models ─────────────────────────────────────────────────────────────────────
def cmd_models(_args):
    have = {k: _hf_cache_has(v["repo"]) for k, v in MODELS.items()}
    have_svd = _hf_cache_has(SVD_REPO)
    device, dtype = _device_and_dtype()
    out({"ok": True, "device": device, "dtype": str(dtype),
         "image_models": {k: {"repo": MODELS[k]["repo"], "downloaded": have[k]} for k in MODELS},
         "svd": {"repo": SVD_REPO, "downloaded": have_svd},
         "default_image": "sdxl-turbo", "default_video_mode": "motion"})


def main():
    ap = argparse.ArgumentParser(description="Local image and video generation for Cleetus.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("image")
    pi.add_argument("--prompt", required=True)
    pi.add_argument("--negative", default="")
    pi.add_argument("--model", default="sdxl-turbo")
    pi.add_argument("--steps", type=int, default=0)
    pi.add_argument("--size", type=int, default=0)
    pi.add_argument("--seed", type=int, default=None)
    pi.add_argument("--out", required=True)
    pi.set_defaults(func=cmd_image)

    pv = sub.add_parser("video")
    pv.add_argument("--prompt", default="")
    pv.add_argument("--image", default="")
    pv.add_argument("--negative", default="")
    pv.add_argument("--model", default="sdxl-turbo")
    pv.add_argument("--steps", type=int, default=0)
    pv.add_argument("--mode", default="motion", choices=["motion", "svd"])
    pv.add_argument("--seconds", type=int, default=4)
    pv.add_argument("--seed", type=int, default=None)
    pv.add_argument("--out", required=True)
    pv.set_defaults(func=cmd_video)

    pm = sub.add_parser("models")
    pm.set_defaults(func=cmd_models)

    args = ap.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as exc:
        import traceback
        log(traceback.format_exc())
        out({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
