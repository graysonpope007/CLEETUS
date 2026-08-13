#!/usr/bin/env python3
"""heretic-probe.py — how long will the real run actually take?

Heretic's cost is dominated by generation: n_trials x eval_prompts x
max_response_length tokens, plus the residual pass. On an RTX 5090 that is a
coffee break. On an M4 Max running a 33.4B mixture-of-experts through
bitsandbytes it is an open question, and the honest way to answer it is to
measure one generation rather than to reason about it.

This loads the model exactly the way the real run will — 4-bit, device_map auto
— times a short batched generation, and prints what the configured trial count
would therefore cost. It is the difference between "start it and see" and
knowing whether to come back in an hour or next week.

    heretic-probe.py [--model DIR] [--batch 8] [--tokens 64]
"""

import argparse
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

PROMPTS = [
    "Write a one-sentence description of a lighthouse.",
    "What is the capital of Portugal?",
    "Explain in two sentences why the sky is blue.",
    "Name three common types of bread.",
    "Summarise what a compiler does.",
    "Give one tip for keeping houseplants alive.",
    "What is the difference between RAM and disk?",
    "Describe the taste of a lemon.",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(Path.home() / "models/Laguna-XS-2.1"))
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--tokens", type=int, default=64)
    # Matches the config: 60 trials, three scorers, 64 eval prompts each for the
    # two that generate (KL divergence needs only a first-token distribution).
    ap.add_argument("--trials", type=int, default=60)
    ap.add_argument("--eval-prompts", type=int, default=128)
    # NOT "auto". Accelerate sizes the device by asking how much is free RIGHT
    # NOW, and on unified memory that is whatever the rest of the machine has
    # not taken — Ollama alone was holding 33 GB. It then decides part of the
    # model has to live on CPU or disk, and bitsandbytes refuses to be split
    # that way, so the load fails outright with a message about GPU RAM on a
    # machine that has no separate GPU RAM.
    #
    # Everything on MPS, explicitly. The model is ~20 GB at 4-bit against 68.7
    # GB of unified memory; the constraint accelerate inferred was not real.
    ap.add_argument("--device-map", default="mps")
    a = ap.parse_args()

    print(f"loading {a.model} in 4-bit...")
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(a.model)
    model = AutoModelForCausalLM.from_pretrained(
        a.model,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
        ),
        device_map={"": a.device_map},
        dtype=torch.bfloat16,
    )
    model.eval()
    load_s = time.time() - t0
    dev = next(model.parameters()).device
    print(f"loaded in {load_s:.0f}s on {dev}")

    footprint = model.get_memory_footprint() / 1e9
    print(f"memory footprint: {footprint:.1f} GB")

    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    # Decoder-only models must pad on the LEFT. Right-padding puts pad tokens
    # between the prompt and the first generated token, so every sequence in the
    # batch except the longest continues from padding — the timing still holds
    # but the text is garbage, and a probe that prints garbage invites someone
    # to conclude the model is broken rather than that the harness is.
    tok.padding_side = "left"
    batch = (PROMPTS * ((a.batch // len(PROMPTS)) + 1))[: a.batch]
    enc = tok(batch, return_tensors="pt", padding=True).to(dev)

    # One short warm-up: the first call on MPS compiles kernels, and timing that
    # measures the compiler rather than the model.
    print("warming up...")
    with torch.no_grad():
        model.generate(**enc, max_new_tokens=4, do_sample=False)

    print(f"timing {a.batch} sequences x {a.tokens} tokens...")
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=a.tokens, do_sample=False)
    gen_s = time.time() - t0
    new_tokens = int((out.shape[1] - enc["input_ids"].shape[1]) * out.shape[0])
    tps = new_tokens / gen_s

    print()
    print(f"  {new_tokens} tokens in {gen_s:.1f}s  =  {tps:.1f} tok/s at batch {a.batch}")

    # What the configured run costs at that rate.
    per_trial_tokens = a.eval_prompts * a.tokens
    trial_s = per_trial_tokens / tps
    total_h = (trial_s * a.trials) / 3600
    print()
    print(f"  one trial  ~ {per_trial_tokens} tokens ~ {trial_s/60:.1f} min")
    print(f"  {a.trials} trials ~ {total_h:.1f} hours (generation alone, excluding "
          f"the residual pass and model reloads)")


if __name__ == "__main__":
    main()
