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

# ── Why the pictures looked like AI pictures, and what actually fixes it ──────
#
# The default was sdxl-turbo at three steps with guidance 0.0. That is the fast
# preview setting, and everything people mean by "it looks AI" is in it:
#
#   THREE STEPS. Skin comes out waxy and poreless, hair resolves into strands
#   that never separate, fabric loses weave. Detail is what steps buy.
#
#   GUIDANCE 0.0, which is not a tuning choice but a structural one. Turbo
#   models are distilled to run without classifier-free guidance, and with CFG
#   off the negative prompt is not weak, it is INERT — there is no unconditional
#   pass for it to steer away from. So --negative was accepted, passed through,
#   and did nothing at all on the default model. Every "no plastic skin, no
#   extra fingers" ever typed into this tool was discarded silently.
#
#   BASE SDXL. Base is a generalist trained on everything; it renders a
#   competent illustration of a photograph. Photorealism is what the community
#   fine-tunes are FOR.
#
# So the default is now a photoreal fine-tune at real step counts with real
# guidance, and the turbo models stay for what they are good at: a draft in
# three seconds when you are still deciding what you want.
#
# `real` is the model's own idea of a photograph, appended when the request
# reads photographic — see enrich_prompt. `negative` is per-model because it
# only means anything where guidance is above 1.
MODELS = {
    # THE DEFAULT. RealVisXL V5.0 is an SDXL fine-tune aimed squarely at
    # photorealism: skin texture, believable light falloff, real lens character.
    # About 7 GB, ungated on Hugging Face, and roughly a minute an image on this
    # GPU at 30 steps — slower than turbo by a lot, and the entire point.
    "realvis": {
        "repo": "SG161222/RealVisXL_V5.0", "steps": 30, "guidance": 4.5, "size": 1024,
        "photoreal": True,
        # Trimmed to fit CLIP's 77 tokens — see CLIP_LIMIT. The faults that
        # actually read as "AI" first: plastic skin, mangled hands, the
        # illustration look, and the oversaturated over-sharpened default.
        "negative": "cartoon, illustration, painting, 3d render, cgi, plastic waxy airbrushed skin, "
                    "doll-like, deformed, extra fingers, bad hands, bad anatomy, "
                    "lowres, blurry, oversaturated, watermark, text",
    },
    # Full SDXL base. Kept honest about what it is: a strong generalist, better
    # than turbo, still not a photoreal specialist.
    "sdxl": {
        "repo": "stabilityai/stable-diffusion-xl-base-1.0", "steps": 30, "guidance": 7.0, "size": 1024,
        "negative": "lowres, blurry, jpeg artifacts, deformed, disfigured, extra fingers, bad hands, "
                    "bad anatomy, watermark, signature, text",
    },
    # The drafts. Seconds, not minutes. guidance 0.0 is required by the
    # distillation, which is exactly why negative prompts do nothing here.
    "sdxl-turbo": {"repo": "stabilityai/sdxl-turbo", "steps": 4, "guidance": 0.0, "size": 1024,
                   "no_cfg": True},
    "sd-turbo":   {"repo": "stabilityai/sd-turbo",   "steps": 2, "guidance": 0.0, "size": 512,
                   "no_cfg": True},
    # FLUX.1-schnell: the best prompt adherence and the most convincing skin of
    # anything that will run here, Apache-2.0, four steps. Gated "auto" on
    # Hugging Face, which means it needs an account to have accepted the terms
    # and a token on this machine — there is none, so this fails with a clear
    # message rather than a stack trace. About 34 GB on a 64 GB machine, so it
    # is deliberately opt-in even once a token exists.
    "flux": {
        "repo": "black-forest-labs/FLUX.1-schnell", "steps": 4, "guidance": 0.0, "size": 1024,
        "photoreal": True, "flux": True, "no_cfg": True, "gated": True,
    },
}
DEFAULT_MODEL = "realvis"
SVD_REPO = "stabilityai/stable-video-diffusion-img2vid-xt"

# SDXL was trained on bucketed aspect ratios near a million pixels. Asking it
# for a square when you wanted a portrait is its own realism tell: a standing
# person crammed into 1:1 gets a cropped head or a compressed body, and every
# photograph of a person ever taken is taller than it is wide.
ASPECTS = {
    "square":    (1024, 1024),
    "portrait":  (832, 1216),
    "tall":      (768, 1344),
    "landscape": (1216, 832),
    "wide":      (1344, 768),
}

# ── 77 tokens, and not one more ───────────────────────────────────────────────
# CLIP's text encoder takes 77 tokens. Past that diffusers does not error, it
# TRUNCATES, and prints the warning to stderr where nobody reads it:
#
#     Token indices sequence length is longer than the specified maximum
#     sequence length for this model (81 > 77)
#
# That is exactly what the first version of this file did: a generous style
# suffix and a generous negative prompt, both quietly cut off mid-phrase. A
# negative prompt listing twenty faults where only the first eight survive is
# worse than a short one, because it reads as thorough and is not.
#
# So both are kept deliberately short, and _warn_if_truncated says so out loud
# when a long subject pushes the total over anyway.
CLIP_LIMIT = 77

# Naming a camera, a lens and a light is how you move a diffusion model off its
# default "generic render" mode. It is the cheapest realism win available — no
# extra model, no extra time — and these are the terms that carry most of it.
PHOTO_STYLE = ("photograph, 85mm lens, natural light, shallow depth of field, "
               "visible skin texture, sharp focus, film grain")

# If any of these is in the prompt he has already said what he wants it to look
# like, and pasting a camera on top of "watercolour" is how you get a muddy
# hybrid of both.
_STYLE_WORDS = (
    "photo", "photograph", "photorealistic", "shot on", "lens", "mm f/", "bokeh", "cinematic",
    "illustration", "painting", "painted", "drawing", "sketch", "anime", "manga", "cartoon",
    "comic", "watercolour", "watercolor", "oil on", "render", "3d", "cgi", "pixel art",
    "vector", "logo", "poster", "diagram", "blueprint", "sculpture", "statue",
)


def enrich_prompt(prompt: str, spec: dict, enrich: bool = True) -> str:
    """Give a photoreal model the vocabulary it was fine-tuned on.

    Only for the photoreal models, only when the prompt has not already declared
    a style, and never for something that is plainly not meant to be a
    photograph. "A woman in a field" becomes a photograph of one; "a watercolour
    of a woman in a field" is left exactly as written.
    """
    if not enrich or not spec.get("photoreal"):
        return prompt
    low = prompt.lower()
    if any(w in low for w in _STYLE_WORDS):
        return prompt
    return f"{prompt}, {PHOTO_STYLE}"


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


def _has_hf_token() -> bool:
    """Is there a Hugging Face credential on this machine at all?"""
    if any(os.environ.get(k) for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN")):
        return True
    return (Path.home() / ".cache/huggingface/token").exists()


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

    # A gated repo with no token on this machine fails deep inside the hub
    # client with an HTTP error that reads like the network is down. Say what it
    # actually is, once, before spending anything on it.
    if spec.get("gated") and not _has_hf_token() and not _hf_cache_has(spec["repo"]):
        raise RuntimeError(
            f"{spec['repo']} is gated on Hugging Face and this Mac has no token. "
            "Accept the licence on the model page while signed in, then run "
            "`huggingface-cli login` (or put HF_TOKEN in cleetus.env). "
            f"Until then use the {DEFAULT_MODEL} model, which is ungated and needs nothing.")

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


def _warn_if_truncated(pipe, label: str, text: str) -> None:
    """Count the tokens and say so when CLIP is going to cut the tail off.

    diffusers truncates silently apart from a transformers warning buried in
    stderr, so a prompt whose last third never reached the model looks exactly
    like one that did. Counting it here means the tool result can say which.
    """
    tok = getattr(pipe, "tokenizer", None)
    if tok is None:
        return
    try:
        n = len(tok(text).input_ids)
    except Exception:
        return
    if n > CLIP_LIMIT:
        kept = tok.decode(tok(text).input_ids[1:CLIP_LIMIT - 1])
        log(f"[media] the {label} is {n} tokens and CLIP takes {CLIP_LIMIT}; everything after "
            f"…{kept[-60:]!r} was DROPPED. Shorten it — the tail did not reach the model.")


def _dimensions(args, spec):
    """Width and height, from --aspect or an explicit --size."""
    if args.size:
        return int(args.size), int(args.size)
    if args.aspect and args.aspect in ASPECTS:
        return ASPECTS[args.aspect]
    n = int(spec["size"])
    return n, n


def _render(args, model_key, enrich=True):
    """One image, returned rather than printed, so video can reuse it."""
    import torch

    spec = MODELS[model_key]
    steps = args.steps or spec["steps"]
    width, height = _dimensions(args, spec)
    # An explicit --guidance wins; otherwise the model's own. Zero is a real
    # value here (the turbo models require it), so `or` would be wrong.
    guidance = float(args.guidance) if args.guidance is not None else float(spec["guidance"])
    prompt = enrich_prompt(args.prompt, spec, enrich and not args.no_enrich)

    # Negative prompts only steer where there is a guided pass to steer. Under
    # CFG they are half of what makes an image look photographed; at guidance 0
    # they are ignored by the sampler entirely. Say so rather than accepting the
    # argument and quietly dropping it, which is what used to happen.
    negative = args.negative or spec.get("negative") or ""
    negative_used = bool(negative) and guidance > 1.0
    if negative and not negative_used:
        log(f"[media] note: {model_key} runs at guidance {guidance}, so the negative prompt is ignored "
            f"(no classifier-free guidance to steer). Use a guided model for it to count.")

    pipe = _load_image_pipe(model_key)

    # Say it plainly if the encoder is about to drop the end of either prompt.
    # Only meaningful for the CLIP-based models; FLUX uses T5 and has room.
    if not spec.get("flux"):
        _warn_if_truncated(pipe, "prompt", prompt)
        if negative_used:
            _warn_if_truncated(pipe, "negative prompt", negative)

    gen = None
    if args.seed is not None:
        # MPS generators exist but the reproducible path everyone relies on is a
        # CPU generator; the small transfer is free next to the denoise.
        gen = torch.Generator(device="cpu").manual_seed(int(args.seed))

    log(f"[media] generating {width}x{height}, {steps} steps, guidance {guidance}, model {model_key}")
    t0 = time.time()
    kw = dict(prompt=prompt, num_inference_steps=steps, height=height, width=width, generator=gen)
    if spec.get("flux"):
        # FLUX has no negative prompt and reads `guidance_scale` differently
        # from SDXL; schnell is distilled for guidance 0.
        kw["guidance_scale"] = guidance
        kw["max_sequence_length"] = 256
    else:
        kw["guidance_scale"] = guidance
        kw["negative_prompt"] = negative or None
    image = pipe(**kw).images[0]
    dt = time.time() - t0

    dest = Path(args.out).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)
    return {"ok": True, "kind": "image", "path": str(dest), "model": model_key,
            "steps": steps, "width": width, "height": height, "guidance": guidance,
            "negative_applied": negative_used, "prompt_used": prompt,
            "seed": args.seed, "seconds": round(dt, 1)}


def cmd_image(args):
    if not args.prompt:
        out({"ok": False, "error": "no prompt"})
    model_key = args.model if args.model in MODELS else DEFAULT_MODEL
    out(_render(args, model_key))


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
                                model=args.model, steps=args.steps, size=0,
                                aspect=getattr(args, "aspect", ""), guidance=getattr(args, "guidance", None),
                                no_enrich=getattr(args, "no_enrich", False),
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
    """cmd_image without the process exit — for the video keyframe.

    Goes through _render like everything else, so a keyframe gets the same
    photoreal model, guidance and negative prompt the still would. It used to
    have its own copy of the generation call, which is how it stayed on the old
    turbo defaults after the stills moved off them.
    """
    _render(ns, ns.model if ns.model in MODELS else DEFAULT_MODEL)


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
         "hf_token": _has_hf_token(),
         "image_models": {k: {
             "repo": MODELS[k]["repo"],
             "downloaded": have[k],
             "steps": MODELS[k]["steps"],
             "guidance": MODELS[k]["guidance"],
             "photoreal": bool(MODELS[k].get("photoreal")),
             # Worth reporting: it is the difference between a negative prompt
             # meaning something and being silently discarded.
             "negative_prompt_works": float(MODELS[k]["guidance"]) > 1.0,
             "gated": bool(MODELS[k].get("gated")),
         } for k in MODELS},
         "aspects": {k: f"{w}x{h}" for k, (w, h) in ASPECTS.items()},
         "svd": {"repo": SVD_REPO, "downloaded": have_svd},
         "default_image": DEFAULT_MODEL, "default_video_mode": "motion"})


def main():
    ap = argparse.ArgumentParser(description="Local image and video generation for Cleetus.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("image")
    pi.add_argument("--prompt", required=True)
    pi.add_argument("--negative", default="")
    pi.add_argument("--model", default=DEFAULT_MODEL)
    pi.add_argument("--steps", type=int, default=0)
    pi.add_argument("--size", type=int, default=0)
    pi.add_argument("--aspect", default="", choices=["", *ASPECTS])
    pi.add_argument("--guidance", type=float, default=None)
    pi.add_argument("--no-enrich", dest="no_enrich", action="store_true",
                    help="Do not append photographic style to the prompt.")
    pi.add_argument("--seed", type=int, default=None)
    pi.add_argument("--out", required=True)
    pi.set_defaults(func=cmd_image)

    pv = sub.add_parser("video")
    pv.add_argument("--prompt", default="")
    pv.add_argument("--image", default="")
    pv.add_argument("--negative", default="")
    pv.add_argument("--model", default=DEFAULT_MODEL)
    pv.add_argument("--steps", type=int, default=0)
    pv.add_argument("--aspect", default="", choices=["", *ASPECTS])
    pv.add_argument("--guidance", type=float, default=None)
    pv.add_argument("--no-enrich", dest="no_enrich", action="store_true")
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
