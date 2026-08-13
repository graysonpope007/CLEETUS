#!/usr/bin/env python3
"""merge_lora_streaming.py — apply a LoRA adapter to a model too big to load.

WHY THIS EXISTS
Heretic can decensor Laguna-XS-2.1 on this Mac, but only just: loaded 4-bit
through bitsandbytes the model is ~17 GB, which fits comfortably in 64 GiB.
Its own export path does not fit. Heretic's MERGE strategy reloads the base
model UNQUANTIZED to merge into it, and it says so out loud:

    "WARNING: CPU merging requires dequantizing the entire model to system RAM.
     This can lead to system freezes if you run out of memory."

Laguna-XS-2.1 in bf16 is 66.9 GB. This machine has 68.7 GB of physical RAM,
shared between CPU and GPU, with an operating system in it. Merging that way
does not fail cleanly — it swaps until the machine stops responding.

So Heretic is run with --export-strategy ADAPTER, which writes only the LoRA
(a few hundred MB), and the merge happens HERE, one shard at a time. Peak
memory is one shard plus one tensor: about 6 GB regardless of how big the model
is. The same script would merge a 400B model on a laptop.

THE MATH IS DELIBERATELY UNINTERESTING
Heretic builds its adapter with `lora_alpha = r` (model.py:224, "Apply adapter
at full strength"), no DoRA, no rsLoRA, no dropout, no bias. So the scaling
factor is alpha/r = 1 and the merge is exactly

    W' = W + B @ A

There is no cleverness to get wrong here, and that is the point: the delicate
part of abliteration is choosing the direction and the per-layer strength,
which Heretic already did. This just applies the answer.

WHAT IT REFUSES TO DO
Silently merge nothing. A LoRA key that matches no base tensor, or a base
tensor that matches no LoRA key when one was expected, aborts. The failure this
guards against is the one that leaves you holding a "decensored" model that is
byte-identical to the original, which you would not notice until you had spent
an hour quantizing it and a week wondering why it still refuses.

USAGE
    merge_lora_streaming.py --base ~/models/Laguna-XS-2.1 \
                           --adapter ~/models/Laguna-XS-2.1-heretic-adapter \
                           --out ~/models/Laguna-XS-2.1-heretic
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def load_adapter(adapter_dir: Path):
    """Returns {base_weight_key: (A, B, scaling)} keyed by the tensor in the base model."""
    cfg = json.loads((adapter_dir / "adapter_config.json").read_text())
    r = cfg["r"]
    alpha = cfg.get("lora_alpha", r)
    scaling = alpha / r
    if cfg.get("use_dora") or cfg.get("use_rslora"):
        # Both change the merge formula. Refusing is better than applying the
        # wrong one, which produces a model that is subtly damaged rather than
        # obviously broken.
        sys.exit("This adapter uses DoRA or rsLoRA; the simple merge below is not valid for it.")

    files = sorted(adapter_dir.glob("adapter_model*.safetensors"))
    if not files:
        sys.exit(f"No adapter_model*.safetensors in {adapter_dir}")

    pairs: dict[str, dict[str, torch.Tensor]] = {}
    for f in files:
        with safe_open(f, framework="pt") as fh:
            for key in fh.keys():
                if ".lora_A" not in key and ".lora_B" not in key:
                    continue
                # base_model.model.model.layers.0.self_attn.o_proj.lora_A.weight
                #   -> model.layers.0.self_attn.o_proj.weight
                side = "A" if ".lora_A" in key else "B"
                stem = key.split(".lora_")[0]
                stem = stem.removeprefix("base_model.model.")
                pairs.setdefault(stem + ".weight", {})[side] = fh.get_tensor(key)

    out = {}
    for base_key, ab in pairs.items():
        if "A" not in ab or "B" not in ab:
            sys.exit(f"Adapter has only one half of the pair for {base_key}")
        out[base_key] = (ab["A"], ab["B"], scaling)
    return out, cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, type=Path)
    ap.add_argument("--adapter", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()

    adapter, cfg = load_adapter(a.adapter)
    print(f"adapter: {len(adapter)} target tensors, r={cfg['r']}, "
          f"alpha={cfg.get('lora_alpha')}, scaling={next(iter(adapter.values()))[2]}")

    shards = sorted(a.base.glob("model*.safetensors"))
    if not shards:
        sys.exit(f"No safetensors shards in {a.base}")
    a.out.mkdir(parents=True, exist_ok=True)

    applied: set[str] = set()
    for i, shard in enumerate(shards, 1):
        tensors = {}
        metadata = None
        with safe_open(shard, framework="pt") as fh:
            metadata = fh.metadata()
            for key in fh.keys():
                t = fh.get_tensor(key)
                if key in adapter:
                    A, B, scaling = adapter[key]
                    # float32 for the product. bf16 has 8 bits of mantissa, and
                    # accumulating a rank-r outer product in it loses the small
                    # correction that IS the abliteration.
                    delta = (B.to(torch.float32) @ A.to(torch.float32)) * scaling
                    if delta.shape != t.shape:
                        sys.exit(f"shape mismatch on {key}: base {tuple(t.shape)} vs delta {tuple(delta.shape)}")
                    t = (t.to(torch.float32) + delta).to(t.dtype)
                    applied.add(key)
                tensors[key] = t
        name = shard.name
        save_file(tensors, a.out / name, metadata=metadata or {"format": "pt"})
        print(f"  [{i}/{len(shards)}] {name}: {len(tensors)} tensors, "
              f"{sum(1 for k in tensors if k in applied)} merged")
        del tensors

    missing = set(adapter) - applied
    if missing:
        sys.exit(f"{len(missing)} adapter targets matched no base tensor, e.g. {sorted(missing)[:3]}. "
                 "Nothing was merged for those, so the output would be partly un-abliterated.")
    if not applied:
        sys.exit("Nothing was merged. The output would be identical to the input.")

    # Everything that is not weights: config, tokenizer, generation config.
    for f in a.base.iterdir():
        if f.is_file() and not f.name.startswith("model-") and f.suffix != ".safetensors":
            shutil.copy2(f, a.out / f.name)
        elif f.name == "model.safetensors.index.json":
            shutil.copy2(f, a.out / f.name)

    print(f"\nmerged {len(applied)} tensors into {a.out}")


if __name__ == "__main__":
    main()
