#!/bin/zsh
# heretic-laguna.sh — decensor the model Cleetus actually runs on.
#
# WHAT THIS IS FOR
# cleetusd's own source is full of comments about the same failure: the model
# refusing things it can do. agent.mjs has a `looksFailed` function whose whole
# job is catching it, with worked examples in the comments — "the tax agent said
# it cannot access the Georgia DOR website while holding web_open", "claiming it
# cannot read a file while holding read_file". Those are not safety refusals
# about anything dangerous. They are a model reciting what an assistant is
# supposed to be unable to do, in a process that can do all of it.
#
# Heretic (github.com/p-e-w/heretic) removes that behaviour at the weights,
# using directional ablation with the ablation strength chosen automatically by
# co-minimising refusal rate and KL divergence from the original model. Be
# straight about what it is: it suppresses refusal BROADLY, not only the false
# ones. The model comes out more willing about everything.
#
# THE FOUR FACTS THIS SCRIPT IS SHAPED BY, all measured on this Mac
#
#   1. Laguna-XS-2.1 is a 33.4B MoE. bf16 on disk is 66.9 GB. This Mac has
#      68.7 GB of RAM shared between CPU and GPU. It does not fit.
#   2. bitsandbytes 0.49 DOES work on Apple Silicon (verified: 4-bit quantize
#      and dequantize round-trip on MPS). 4-bit brings the model to ~17 GB,
#      which fits with room to spare. This is the whole reason this is possible
#      on this machine at all.
#   3. Heretic's own MERGE export does NOT fit: it reloads the base model
#      unquantized to merge into, and warns that this "can lead to system
#      freezes". So we export the ADAPTER and merge it ourselves, streaming one
#      shard at a time — see merge_lora_streaming.py.
#   4. Heretic is an interactive tool. Even with --trial-index and
#      --model-action set, it constructs prompt_toolkit objects that touch the
#      terminal, and with stdout redirected that is OSError errno 22 AFTER the
#      optimisation has finished — hours of work thrown away at the last step.
#      Hence `script -q /dev/null`, which gives it a pty.
#
# RESUMABLE. Every stage checks whether its output already exists. The
# optimisation itself checkpoints into ./checkpoints and resumes there, so an
# interrupted run does not start over.
#
#   ./heretic-laguna.sh            run every stage that is not already done
#   ./heretic-laguna.sh download   just fetch the weights
#   ./heretic-laguna.sh abliterate just the Heretic run
#   ./heretic-laguna.sh merge      just the adapter merge
#   ./heretic-laguna.sh package    just the Ollama import
#   ./heretic-laguna.sh activate   point cleetusd at the result
set -euo pipefail

MODEL_ID=${MODEL_ID:-poolside/Laguna-XS-2.1}
BASE=${BASE:-$HOME/models/Laguna-XS-2.1}
ADAPTER=${ADAPTER:-$HOME/models/Laguna-XS-2.1-heretic-adapter}
MERGED=${MERGED:-$HOME/models/Laguna-XS-2.1-heretic}
OLLAMA_NAME=${OLLAMA_NAME:-laguna-xs-2.1-heretic:q8_0}
WORK=${WORK:-$HOME/models/heretic-work}
HERETIC=${HERETIC:-$HOME/heretic/.venv/bin/heretic}
PY=${PY:-$HOME/heretic/.venv/bin/python}

say() { print -P "%F{yellow}==>%f $*"; }

preflight() {
  [[ -x $HERETIC ]] || { print "Heretic is not installed at $HERETIC (cd ~/heretic && uv sync)"; exit 1; }
  command -v ollama >/dev/null || { print "ollama is not on PATH"; exit 1; }
  # 67 GB in, 67 GB out, and the Ollama blob on top. Checked up front because
  # discovering it three hours in means doing the three hours again.
  local free_gb=$(df -g "$HOME" | tail -1 | awk '{print $4}')
  say "free disk: ${free_gb} GB"
  (( free_gb > 150 )) || { print "Need >150 GB free; have ${free_gb} GB."; exit 1; }
  mkdir -p "$WORK"
}

stage_download() {
  if [[ -f $BASE/model.safetensors.index.json ]] && \
     [[ $(ls "$BASE"/model-*.safetensors 2>/dev/null | wc -l) -ge 14 ]]; then
    say "weights already present in $BASE"; return
  fi
  say "downloading $MODEL_ID (66.9 GB) -> $BASE"
  "$HOME/heretic/.venv/bin/hf" download "$MODEL_ID" --local-dir "$BASE"
}

stage_abliterate() {
  if [[ -f $ADAPTER/adapter_model.safetensors ]]; then
    say "adapter already present in $ADAPTER"; return
  fi
  [[ -f $WORK/config.toml ]] || { print "Missing $WORK/config.toml"; exit 1; }

  # ── unload Ollama first, and this is not housekeeping ──
  #
  # Measured, because the first attempt looked like a hang: Ollama holds its
  # models with keep_alive forever, which was 36 GB of laguna plus 7.5 GB of the
  # gate model, all wired. With that resident the probe sat at 27% CPU for nine
  # minutes with 73 MB of free RAM and 76 of 76.8 GB of swap in use, making no
  # progress at all. Unloading took wired memory from 46.9 GB to 6.8 GB.
  #
  # It is not destructive. Ollama reloads on the next request; cleetusd's first
  # message after this pays a minute of load time and nothing else. Doing it
  # explicitly beats letting two processes fight over the same unified memory
  # and calling the result a performance mystery.
  say "unloading Ollama models to free unified memory"
  ollama stop laguna-xs-2.1:q8_0 >/dev/null 2>&1 || true
  ollama stop lfm2.5:8b >/dev/null 2>&1 || true

  say "running Heretic (4-bit, MPS). This is the long one."
  cd "$WORK"
  # transformers 5.15 warns that this tokenizer uses "an incorrect regex
  # pattern" and offers fix_mistral_regex=True. DO NOT TAKE IT. The pattern is
  # the one poolside shipped in tokenizer.json, and it is the one Ollama uses at
  # inference. Heretic's whole job here is to observe activations that resemble
  # the ones the deployed model will have; tokenizing differently from
  # deployment would introduce exactly the mismatch the abliteration is supposed
  # to be measured against. The warning is advisory and applying it would make
  # this worse, not better.
  # script(1) gives it a pty. Without one, Heretic dies at the save step with
  # OSError errno 22 after the optimisation is complete — which is the most
  # expensive possible place to fail.
  # --device-map is NOT "auto", and this is measured rather than cautious.
  # Accelerate sizes a device by asking what is free at that moment, and on
  # unified memory that is whatever the rest of the Mac has not taken — Ollama
  # alone holds 33 GB while it has the model warm. It then decides part of the
  # model belongs on CPU or disk, and bitsandbytes refuses to be split that way:
  #
  #   ValueError: Some modules are dispatched on the CPU or the disk. Make sure
  #   you have enough GPU RAM to fit the quantized model.
  #
  # On a machine with no separate GPU RAM, on a 20 GB model, with 68.7 GB in the
  # box. The constraint was inferred, not real. Pinning to mps removes it.
  #
  # If this run is competing with a warm Ollama, `ollama stop laguna-xs-2.1:q8_0`
  # first — it does not change correctness, it changes whether the machine swaps.
  script -q /dev/null "$HERETIC" \
    --model "$BASE" \
    --quantization BNB_4BIT \
    --device-map mps \
    --export-strategy ADAPTER \
    --checkpoint-action resume \
    --trial-index 0 \
    --model-action save \
    --save-directory "$ADAPTER" 2>&1 | tee -a "$WORK/heretic.log"
  [[ -f $ADAPTER/adapter_model.safetensors ]] || { print "Heretic did not write an adapter."; exit 1; }
}

stage_merge() {
  if [[ -f $MERGED/model.safetensors.index.json ]]; then
    say "merged model already present in $MERGED"; return
  fi
  say "merging the adapter into bf16 weights, one shard at a time"
  "$PY" "$HOME/cleetusd/bin/merge_lora_streaming.py" \
    --base "$BASE" --adapter "$ADAPTER" --out "$MERGED"
}

stage_package() {
  if ollama list 2>/dev/null | grep -q "^${OLLAMA_NAME%%:*}"; then
    say "$OLLAMA_NAME already exists in ollama"; return
  fi
  say "importing into ollama as $OLLAMA_NAME"
  # The renderer and parser are NOT optional. Laguna speaks a poolside-specific
  # chat and tool-call format; import it without these and it loads, answers,
  # and silently never calls a tool again — which for Cleetus is the entire
  # product. Taken from the original model rather than typed from memory.
  ollama show --modelfile laguna-xs-2.1:q8_0 \
    | sed "1,/^FROM /d" \
    | { print "FROM $MERGED"; cat; } > "$WORK/Modelfile"
  ollama create "$OLLAMA_NAME" -f "$WORK/Modelfile" --quantize q8_0 --experimental
}

stage_activate() {
  say "pointing cleetusd at $OLLAMA_NAME"
  # Written into cleetusd's own env rather than the shared cleetus.env: that
  # file belongs to the whole stack and cleetusd does not write to it.
  local envfile="$HOME/cleetusd/.env"
  if grep -q '^CLEETUSD_MODEL=' "$envfile" 2>/dev/null; then
    sed -i '' "s|^CLEETUSD_MODEL=.*|CLEETUSD_MODEL=$OLLAMA_NAME|" "$envfile"
  else
    print "CLEETUSD_MODEL=$OLLAMA_NAME" >> "$envfile"
  fi
  launchctl kickstart -k "gui/$(id -u)/com.cleetus.cleetusd"
  say "restarted. Verify with: curl -s 127.0.0.1:8767/health | grep model"
}

case ${1:-all} in
  download)   preflight; stage_download ;;
  abliterate) preflight; stage_abliterate ;;
  merge)      preflight; stage_merge ;;
  package)    preflight; stage_package ;;
  activate)   stage_activate ;;
  all)        preflight; stage_download; stage_abliterate; stage_merge; stage_package
              say "done. Run '$0 activate' to switch cleetusd over to it." ;;
  *) print "usage: $0 [all|download|abliterate|merge|package|activate]"; exit 1 ;;
esac
