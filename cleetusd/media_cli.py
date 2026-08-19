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
capped by this machine's 64 GB of unified memory, not a datacentre. Video is the
hard part — true generative video diffusion (Stable Video Diffusion) runs here
but is heavy, so there are two paths and the command says which it used.

THE MODELS, chosen for this machine
  realvis      DEFAULT. RealVisXL V5.0, a photoreal SDXL fine-tune. 30 steps,
               guidance 4.5, ~40s an image on this GPU. Slower than turbo by an
               order of magnitude, and that is the entire point — see the long
               note above MODELS for why the turbo default looked like AI.
  sdxl         full SDXL base. A strong generalist, not a photoreal specialist.
  sdxl-turbo   the DRAFT model. ~4 steps, guidance off, seconds per image.
               Right when he is still deciding what he wants, wrong as a
               default. Negative prompts do nothing here.
  sd-turbo     smaller and faster still, 512px. Same caveat.
  flux         FLUX.1-schnell. The best of them, gated on Hugging Face, and this
               Mac has no token — it says so rather than failing obscurely.
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
import secrets
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
        # What its own model card asks for. See _retune_scheduler.
        "scheduler": "sde-dpmsolver++",
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
        # Base SDXL is guided and many-step too, so it takes the same benefit.
        "scheduler": "dpmsolver++",
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


# ── The sampler the model was actually tuned for ─────────────────────────────
#
# RealVisXL ships with DDIMScheduler in its repo config, so that is what
# diffusers loads, and it is not what the fine-tune was made to be run with.
# Its own model card asks for DPM++ SDE Karras. The difference at 30 steps is
# not subtle and it is exactly the axis this file already cares about: fine
# detail, skin and hair texture, the difference between a photograph and a
# render of one.
#
# Karras sigmas are the other half. They redistribute the noise schedule so
# more steps are spent where the image is actually being decided, which is what
# makes 30 steps behave like a much larger number.
#
# NOT for the turbo models. They are DISTILLED — the scheduler is part of what
# was distilled, and swapping it does not make them better, it makes them
# wrong. FLUX is flow-matching and has nothing to do with any of this. So the
# swap is per-model and opt-in via the spec, rather than applied to everything
# that happens to load through here.
def _retune_scheduler(pipe, spec):
    want = spec.get("scheduler")
    if not want:
        return None
    try:
        from diffusers import DPMSolverMultistepScheduler
        pipe.scheduler = DPMSolverMultistepScheduler.from_config(
            pipe.scheduler.config,
            algorithm_type=want,
            use_karras_sigmas=True,
        )
        return f"{want} with Karras sigmas"
    except Exception as exc:
        # A scheduler that will not build is not worth failing a picture over;
        # the model's own default still produces an image.
        log(f"[media] could not retune the scheduler ({exc}); keeping "
            f"{type(pipe.scheduler).__name__}")
        return None


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
            f"{spec['repo']} is auto-gated on Hugging Face and no token reached this process. "
            "It is Apache-2.0, so the gate is a one-time terms acceptance rather than an approval "
            "queue: sign in on the model page and accept, then put the token in EITHER place — the "
            "deck's Keys form (as HF_TOKEN) or cleetus.env. Both are read and both are passed "
            "through to this process. "
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
    tuned = _retune_scheduler(pipe, spec)
    log(f"[media] pipe ready in {time.time() - t0:.1f}s"
        + (f", sampling with {tuned}" if tuned else f", sampling with {type(pipe.scheduler).__name__}"))
    _PIPE_CACHE[model_key] = pipe
    return pipe


# ── Starting from a picture instead of from noise ────────────────────────────
#
# Every accuracy problem so far has been about getting words to the sampler
# intact. This is the other half, and it is the bigger one: some things cannot
# be said in words at all. The exact blue of a brand. The particular grain and
# colour of a photograph he likes. A room's real proportions. He can describe
# those for a paragraph and still not get them, because the description is
# lossy in a way the picture is not.
#
# So: hand it the picture. Text-to-image starts from pure noise; image-to-image
# starts from HIS image with some noise added, and STRENGTH is how much. 0.25
# is a grade and a nudge, 0.5 is the same scene reinterpreted, 0.8 is loosely
# inspired by. At 1.0 the reference is gone and this is text-to-image again.
#
# from_pipe rather than a second from_pretrained: it reuses the UNet, VAE and
# both text encoders already resident, so a reference costs no extra download
# and no extra memory on a machine where the model is most of the 64 GB.
_I2I_CACHE = {}


def _load_img2img_pipe(model_key: str):
    if model_key in _I2I_CACHE:
        return _I2I_CACHE[model_key]
    from diffusers import AutoPipelineForImage2Image
    base = _load_image_pipe(model_key)
    pipe = AutoPipelineForImage2Image.from_pipe(base)

    # ── Attention slicing produces NaN here, and only here ──────────────────
    #
    # Measured, not guessed. The first reference image came back pure black
    # with `"ok": true` on it. The VAE encode was clean — no NaN, latents with
    # an absmax of 21 — so the overflow was in the denoise, and the variable
    # was slicing:
    #
    #   slicing on,  strength 0.55  ->  nan
    #   slicing off, strength 0.55  ->  absmax 2.49
    #   slicing off, strength 0.30  ->  absmax 2.44
    #   slicing off, strength 0.90  ->  absmax 3.25
    #
    # Text-to-image with the same sliced UNet is fine, which is exactly why
    # nothing caught this: every picture this file has ever made took the other
    # path. The extra memory is affordable and a black image is not.
    #
    # Safe despite sharing the UNet with the text2img pipe above, because this
    # process makes ONE image and exits — there is no later text2img call in it
    # to be affected.
    try:
        pipe.disable_attention_slicing()
    except Exception:
        pass

    _I2I_CACHE[model_key] = pipe
    return pipe


def _load_reference(path: str, width: int, height: int):
    """His picture, opened and fitted to the output size.

    COVER, not stretch. A 4:5 reference squeezed into 16:9 changes every face
    and every proportion in it, which is the one thing a reference is for. So
    it is scaled to cover and centre-cropped, the way any layout tool would.
    """
    from PIL import Image
    img = Image.open(Path(path).expanduser()).convert("RGB")
    src_w, src_h = img.size
    scale = max(width / src_w, height / src_h)
    fitted = img.resize((max(1, round(src_w * scale)), max(1, round(src_h * scale))), Image.LANCZOS)
    left = (fitted.width - width) // 2
    top = (fitted.height - height) // 2
    return fitted.crop((left, top, left + width, top + height))


def _reference_aspect(path: str):
    """The shape of his reference, as the nearest thing this file can render.

    If he handed over a picture and did not say what shape he wanted, the
    picture is the answer. Silently rendering his 4:5 reference as a square is
    a variation he did not ask for, and the most visible kind.
    """
    try:
        from PIL import Image
        with Image.open(Path(path).expanduser()) as img:
            w, h = img.size
    except Exception:
        return None
    if not w or not h:
        return None
    ratio = w / h
    best, gap = None, None
    for name, (aw, ah) in ASPECTS.items():
        d = abs(ratio - aw / ah)
        if gap is None or d < gap:
            best, gap = name, d
    return best


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


# ── Saying all of it, rather than the first seventy-seven tokens ─────────────
#
# _warn_if_truncated above tells the truth and does nothing about it. What it
# is telling the truth about, measured on this machine with the real tokenizer:
#
#   "a bassist on a dim club stage, blue rim light from behind, sweat on his
#    forearms, a Fender P-Bass, crowd out of focus in the foreground, shot from
#    the pit looking up, and a bright red umbrella propped against the amp"
#
# is 53 tokens. The photographic style appended to it is 25 more. 78 > 77, so
# the sampler never saw the film grain — and a prompt six words longer than
# that loses the umbrella instead, without anybody being told which.
#
# That is the whole "it did not make what I asked for" complaint, and it is not
# a model weakness: the words never arrived. CLIP's encoder takes 77 tokens per
# forward pass, but nothing says a prompt may only have one forward pass. Split
# it into 75-token pieces, run each through the encoder, and concatenate the
# hidden states along the sequence axis. Cross-attention reads a sequence; it
# does not care that the sequence was assembled from three passes.
#
# ONLY WHEN IT WOULD OTHERWISE BE CUT. A short prompt takes the ordinary path
# untouched, deliberately: every seed Grayson has written down was produced by
# that path, and routing them through a different encoding would quietly stop
# reproducing the pictures he saved the seeds for. This changes what happens to
# prompts that were being damaged and nothing else.
def _chunked_ids(tokenizer, text, chunk=75):
    """The prompt as a list of 77-long id windows, bos/eos on each, padded."""
    ids = tokenizer(text, truncation=False, add_special_tokens=False).input_ids
    bos, eos = tokenizer.bos_token_id, tokenizer.eos_token_id
    pad = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos
    windows = []
    for i in range(0, max(len(ids), 1), chunk):
        piece = ids[i:i + chunk]
        piece = [bos] + piece + [eos]
        piece += [pad] * (chunk + 2 - len(piece))
        windows.append(piece)
    return windows


def _encode_long(pipe, text, device, want_chunks=None):
    """Encode a prompt of any length into (hidden_states, pooled).

    Two encoders on SDXL, one on SD. The hidden state taken is the penultimate
    layer, which is what diffusers itself uses — taking the last one is a
    subtle, hard-to-see quality regression rather than an error.

    The POOLED vector comes from the first window only. It is a single summary
    embedding with no sequence axis to extend, so there is nothing to
    concatenate; averaging the windows was tried and reads as a muddier
    composition. First window means the pooled summary describes the opening of
    the prompt, which is where the subject is.
    """
    import torch

    toks = [pipe.tokenizer]
    encs = [pipe.text_encoder]
    if getattr(pipe, "tokenizer_2", None) is not None:
        toks.append(pipe.tokenizer_2)
        encs.append(pipe.text_encoder_2)

    per_encoder = []
    pooled = None
    n_windows = None
    for tok, enc in zip(toks, encs):
        windows = _chunked_ids(tok, text)
        if want_chunks is not None and len(windows) < want_chunks:
            # The prompt and the negative prompt must come out the same length:
            # the sampler stacks them into one batch and a ragged pair is a
            # shape error at the worst possible moment, after the model load.
            pad_row = _chunked_ids(tok, "")[0]
            windows = windows + [pad_row] * (want_chunks - len(windows))
        n_windows = len(windows)
        states = []
        for w_i, w in enumerate(windows):
            ids = torch.tensor([w], dtype=torch.long, device=device)
            out = enc(ids, output_hidden_states=True)
            states.append(out.hidden_states[-2])
            # text_encoder_2 is the one carrying the pooled vector on SDXL; on
            # SD there is only one encoder and the pipeline wants no pooled at all.
            if w_i == 0 and enc is encs[-1] and len(encs) > 1:
                pooled = out[0]
        per_encoder.append(torch.cat(states, dim=1))

    # SDXL concatenates the two encoders on the FEATURE axis (768 + 1280 = 2048).
    embeds = torch.cat(per_encoder, dim=-1) if len(per_encoder) > 1 else per_encoder[0]
    return embeds, pooled, n_windows


def _long_prompt_kwargs(pipe, prompt, negative, device):
    """prompt_embeds/negative_prompt_embeds, or None when the short path is fine."""
    limit = CLIP_LIMIT
    n_prompt = len(pipe.tokenizer(prompt, truncation=False).input_ids)
    n_negative = len(pipe.tokenizer(negative or "", truncation=False).input_ids)
    if n_prompt <= limit and n_negative <= limit:
        return None, None

    import torch

    # Both sides get the same number of windows — see the note in _encode_long.
    want = max(-(-max(n_prompt, n_negative) // 75), 1)
    p_embeds, p_pooled, _ = _encode_long(pipe, prompt, device, want_chunks=want)
    n_embeds, n_pooled, _ = _encode_long(pipe, negative or "", device, want_chunks=want)

    kw = {"prompt_embeds": p_embeds, "negative_prompt_embeds": n_embeds}
    if p_pooled is not None:
        kw["pooled_prompt_embeds"] = p_pooled
        kw["negative_pooled_prompt_embeds"] = n_pooled
    note = (f"the prompt is {n_prompt} tokens, past CLIP's {limit}, so it was encoded in "
            f"{want} passes and all of it reached the model")
    return kw, note


def _dimensions(args, spec):
    """Width and height, from --aspect, an explicit --size, or the reference."""
    if args.size:
        return int(args.size), int(args.size)
    if args.aspect and args.aspect in ASPECTS:
        return ASPECTS[args.aspect]
    # He handed over a picture and did not say what shape he wanted. The
    # picture is the answer, and rendering his 4:5 reference as a square is the
    # most visible possible variation on what he asked for.
    ref = getattr(args, "reference", "")
    if ref:
        from_ref = _reference_aspect(ref)
        if from_ref:
            return ASPECTS[from_ref]
    n = int(spec["size"])
    return n, n


def _merge_negative(asked: str, default: str) -> str:
    """His negative prompt AND the model's, in that order, without repeats.

    His first because the leading terms of a negative prompt carry the most
    weight, and the thing he actually said to keep out should not be sitting
    behind twelve words about skin texture.
    """
    parts, seen = [], set()
    for chunk in (asked or "", default or ""):
        for term in (t.strip() for t in chunk.split(",")):
            key = term.lower()
            if term and key not in seen:
                seen.add(key)
                parts.append(term)
    return ", ".join(parts)


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
    # COMBINED, not replaced.
    #
    # This was `args.negative or spec.get("negative")`, so the moment anything
    # passed a negative prompt of its own the model's tuned one vanished — and
    # that tuned one is the whole anti-plastic-skin, anti-mangled-hands list
    # that keeps realvis from looking generated. Asking for "no people on the
    # beach" therefore also asked, silently, for waxy skin and bad anatomy back.
    #
    # It was written that way for a real reason: two lists concatenated blow
    # past CLIP's 77 tokens and the tail is dropped. That is no longer true —
    # long prompts are encoded in windows now, negative included — so the
    # correct behaviour is finally affordable.
    negative = _merge_negative(args.negative, spec.get("negative"))
    negative_used = bool(negative) and guidance > 1.0
    if negative and not negative_used:
        log(f"[media] note: {model_key} runs at guidance {guidance}, so the negative prompt is ignored "
            f"(no classifier-free guidance to steer). Use a guided model for it to count.")

    reference = getattr(args, "reference", "") or ""
    strength = getattr(args, "strength", None)
    if reference and not Path(reference).expanduser().exists():
        return {"ok": False, "error": f"no such reference image: {reference}"}
    if reference:
        # Clamped rather than rejected: a 0 would hand his own file back
        # unchanged and a 1.2 would throw from inside the scheduler.
        strength = 0.55 if strength is None else max(0.05, min(1.0, float(strength)))

    pipe = _load_img2img_pipe(model_key) if reference else _load_image_pipe(model_key)

    # Nothing is dropped any more, but say what had to be done about it.
    # FLUX is on T5 with room to spare and takes the ordinary path.
    long_kw, long_note = (None, None)
    if not spec.get("flux"):
        _warn_if_truncated(pipe, "prompt", prompt)
        long_kw, long_note = _long_prompt_kwargs(
            pipe, prompt, negative if negative_used else "", pipe.device)
        if long_note:
            log(f"[media] {long_note}")

    # ALWAYS a real seed, even when none was asked for.
    #
    # Omitting it used to mean the sampler got no generator and the result was
    # unreproducible, with `seed: null` in the output. The agent is told to
    # report the seed back — because reusing it is how a picture he liked gets
    # adjusted rather than replaced — and faced with a null it invented one:
    # it read the timestamp out of the filename and presented that as the seed.
    # Confidently wrong, and useless the moment he tried to reuse it.
    #
    # So one is drawn here when absent. Every image is reproducible, and the
    # number handed back is the number that made it.
    seed = int(args.seed) if args.seed is not None else secrets.randbelow(2**31 - 1)
    # MPS generators exist but the reproducible path everyone relies on is a
    # CPU generator; the small transfer is free next to the denoise.
    gen = torch.Generator(device="cpu").manual_seed(seed)

    kw = dict(prompt=prompt, num_inference_steps=steps, generator=gen)
    if reference:
        # img2img takes its size FROM the image, and passing height/width as
        # well is an error rather than a preference — the picture is already
        # the shape it is going to be, which is why it is fitted on the way in.
        kw["image"] = _load_reference(reference, width, height)
        kw["strength"] = strength
        # Steps are spent proportionally to strength: diffusers starts the
        # denoise partway along the schedule, so 30 steps at strength 0.4 is
        # twelve actual steps and a mushy picture. Scale up so the number of
        # steps that RUN is the number the model was tuned for.
        steps = min(120, max(steps, int(round(steps / max(strength, 0.15)))))
        kw["num_inference_steps"] = steps
        log(f"[media] generating from a reference at strength {strength}, "
            f"{width}x{height}, {steps} scheduled steps, model {model_key}")
    else:
        kw["height"] = height
        kw["width"] = width
        log(f"[media] generating {width}x{height}, {steps} steps, guidance {guidance}, model {model_key}")
    t0 = time.time()
    if spec.get("flux"):
        # FLUX has no negative prompt and reads `guidance_scale` differently
        # from SDXL; schnell is distilled for guidance 0.
        kw["guidance_scale"] = guidance
        kw["max_sequence_length"] = 256
    else:
        kw["guidance_scale"] = guidance
        if long_kw:
            # Embeddings and raw strings are mutually exclusive: diffusers
            # raises rather than picking one, which is the right call — and it
            # caught this on the first run, when `prompt` was still sitting in
            # kw from the line that builds it.
            kw.pop("prompt", None)
            kw.update(long_kw)
        else:
            kw["negative_prompt"] = negative or None
    image = pipe(**kw).images[0]
    dt = time.time() - t0

    # ── An all-black frame is a FAILURE, and it used to report success ──────
    #
    # A NaN anywhere in the denoise decodes to a uniform black picture, and
    # every layer above happily called that a finished image: `"ok": true`, a
    # path, a seed, a plausible duration. The agent then told him it had made
    # his picture. That is the worst shape a bug can take here — not a crash,
    # an assurance.
    #
    # So the pixels are looked at before the result is written. A real photograph
    # of a dark room still has variation in it; a NaN decode has none at all,
    # which is what makes this cheap to test and safe against false positives.
    stats = image.convert("L").getextrema()
    if stats[1] <= 2:
        return {"ok": False,
                "error": "the sampler produced an all-black frame, which means a numeric overflow "
                         "in the denoise rather than a picture. Nothing was saved. If this used a "
                         "reference image, try again without one, or with a different model.",
                "model": model_key, "seed": seed}

    # ── A pipeline that has decoded once will not decode again ──────────────
    #
    # Measured, and it is not this file's fault. A second _render in the same
    # process returns a pure black frame, every time:
    #
    #   run 1  -> a picture
    #   run 2  -> black
    #   run 3  -> black
    #
    # It is NOT the model and it is NOT the sampler. Diagnosed by taking the
    # stages apart on run 2: the latents come back finite with a normal absmax,
    # every tensor in the UNet and the VAE is still finite, and decoding those
    # same latents BY HAND produces a correct image. The fault is inside
    # diffusers' own postprocess — the upcast-the-VAE-to-fp32-and-back dance it
    # does around decode, which is deprecated in this version and misbehaves on
    # MPS the second time through. It reproduces identically on DDIM, so it
    # predates the scheduler retune.
    #
    # Nothing in production hits it today, because this script makes one image
    # and exits. That is exactly what makes it worth handling rather than
    # noting: the day anything renders twice in one process — a batch of
    # variations, a contact sheet, a retry — it would come back black.
    #
    # So the pipe is dropped from the cache once it has produced a picture. A
    # second render in the same process pays a few seconds to reload rather
    # than returning nothing, and the weights are still in the OS page cache so
    # it is cheaper than it sounds.
    _PIPE_CACHE.pop(model_key, None)
    _I2I_CACHE.pop(model_key, None)

    dest = Path(args.out).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)
    return {"ok": True, "kind": "image", "path": str(dest), "model": model_key,
            "steps": steps, "width": width, "height": height, "guidance": guidance,
            "negative_applied": negative_used, "prompt_used": prompt,
            "long_prompt": long_note, "seed": seed, "seconds": round(dt, 1),
            "reference": reference or None, "strength": strength if reference else None}


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


def _image_size(path):
    """Width and height of a file on disk, without loading the pixels."""
    from PIL import Image
    with Image.open(Path(path).expanduser()) as img:
        return img.size


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

    # ── The video is the shape of the keyframe, not always a square ──────────
    #
    # This used to be `scale=2048:2048` and `s=1024x1024`, hardcoded, with no
    # aspect preservation on either. Measured: an 832x1216 portrait keyframe
    # came out a 1024x1024 video, which is not a crop — it is the whole picture
    # SQUASHED, every face and every proportion in it wrong, silently, on every
    # video this file has ever made.
    #
    # It also meant a 9:16 story and a 16:9 hero were both impossible to make,
    # whatever --aspect said, because the aspect only ever reached the keyframe
    # and the render threw it away again.
    kw, kh = _image_size(keyframe)
    # h264 needs even dimensions; an odd one fails the encode outright.
    kw, kh = kw - (kw % 2), kh - (kh % 2)
    zoom = "zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" \
           f":d={frames}:s={kw}x{kh}:fps={fps}"
    cmd = [_ffmpeg(), "-y", "-loglevel", "error", "-loop", "1", "-i", keyframe,
           # Doubled before the zoompan for the same reason as before — it is
           # what stops zoompan's single-pixel-per-frame jitter — but doubled
           # in BOTH dimensions from the real size rather than to a square.
           "-vf", f"scale={kw * 2}:{kh * 2},{zoom},format=yuv420p", "-t", str(seconds),
           "-c:v", "libx264", "-preset", "medium", "-movflags", "+faststart", str(dest)]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        out({"ok": False, "error": f"ffmpeg failed: {r.stderr[-400:]}", "keyframe": keyframe})
    out({"ok": True, "kind": "video", "mode": "motion", "path": str(dest),
         "keyframe": keyframe, "seconds": seconds, "fps": fps,
         "width": kw, "height": kh,
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
    pi.add_argument("--reference", default="",
                    help="An image to start from instead of noise (image-to-image).")
    pi.add_argument("--strength", type=float, default=None,
                    help="How far to move from the reference: 0.25 a nudge, 0.55 default, "
                         "0.85 loosely inspired by. Only meaningful with --reference.")
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
