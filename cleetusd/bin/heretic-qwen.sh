#!/bin/zsh
# heretic-qwen.sh — decensor the Qwen model Cleetus runs on.
#
# Adapted 2026-09-15 from heretic-laguna.sh to swap Laguna for Qwen3-32B, the
# most capable Qwen that (a) runs on this 64 GB box and (b) Heretic can
# manipulate COMPLETELY. Qwen3-32B is DENSE: every targeted module (o_proj,
# down_proj) is a plain nn.Linear, so unlike Laguna's MoE (whose 256 routed
# experts per layer bitsandbytes never touched, see the laguna memory note) the
# abliteration reaches the whole model. 4-bit it is ~18 GB, so it fits with room
# for the forward passes Heretic runs hundreds of times.
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

MODEL_ID=${MODEL_ID:-Qwen/Qwen2.5-14B-Instruct}
BASE=${BASE:-$HOME/models/Qwen2.5-14B-Instruct}
ADAPTER=${ADAPTER:-$HOME/models/Qwen2.5-14B-Instruct-heretic-adapter}
MERGED=${MERGED:-$HOME/models/Qwen2.5-14B-Instruct-heretic}
OLLAMA_NAME=${OLLAMA_NAME:-qwen2.5-14b-heretic:q8_0}
WORK=${WORK:-$HOME/models/heretic-work-qwen}
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
     [[ $(ls "$BASE"/model-*.safetensors 2>/dev/null | wc -l) -ge 5 ]]; then
    say "weights already present in $BASE"; return
  fi
  say "downloading $MODEL_ID (~28 GB bf16) -> $BASE"
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

  say "running Heretic (bf16, MPS). This is the long one."
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
    --quantization NONE \
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
  # Qwen3 is a first-class Ollama architecture, so importing the safetensors
  # directory is enough: Ollama applies its built-in Qwen3 chat template, which
  # already carries tool-calling and the think switch cleetusd relies on. This
  # is the opposite of Laguna, whose poolside format had to be copied by hand.
  # Tool-calling is VERIFIED by stage_verify before activate is allowed to run.
  print "FROM $MERGED" > "$WORK/Modelfile"
  ollama create "$OLLAMA_NAME" -f "$WORK/Modelfile" --quantize q8_0
}

stage_verify() {
  # The one thing that matters for Cleetus: does it still call tools? A model
  # that loads and chats but never emits a tool call is useless here, and that
  # failure is silent. Ask it something that forces a tool and check the reply
  # carries a tool_calls array.
  say "verifying tool-calling on $OLLAMA_NAME"
  local out
  out=$(curl -s http://127.0.0.1:11434/api/chat -d "{
    \"model\": \"$OLLAMA_NAME\", \"stream\": false, \"think\": false,
    \"messages\": [{\"role\":\"user\",\"content\":\"What is 37*41? Use the calculator tool.\"}],
    \"tools\": [{\"type\":\"function\",\"function\":{\"name\":\"calculator\",\"description\":\"do arithmetic\",\"parameters\":{\"type\":\"object\",\"properties\":{\"expression\":{\"type\":\"string\"}},\"required\":[\"expression\"]}}}]
  }")
  if print -r -- "$out" | grep -q '"tool_calls"'; then
    say "tool-calling OK"
  else
    print "WARNING: $OLLAMA_NAME did not emit a tool call. Do NOT activate yet."
    print -r -- "$out" | head -c 800
    return 1
  fi
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
  # Laguna is finished the moment Cleetus is on the Qwen build. Remove the 35 GB
  # Ollama model now (the 76 GB base weights were already deleted 2026-09-15).
  # Guarded so a re-run does not error once it is gone.
  if ollama list 2>/dev/null | grep -q "^laguna-xs-2.1"; then
    say "removing the old laguna Ollama model"
    ollama rm laguna-xs-2.1:q8_0 >/dev/null 2>&1 || true
  fi
}

case ${1:-all} in
  download)   preflight; stage_download ;;
  abliterate) preflight; stage_abliterate ;;
  merge)      preflight; stage_merge ;;
  package)    preflight; stage_package ;;
  verify)     stage_verify ;;
  activate)   stage_verify && stage_activate ;;
  all)        preflight; stage_download; stage_abliterate; stage_merge; stage_package
              say "built. Run '$0 verify' then '$0 activate' to switch cleetusd over." ;;
  build)      preflight; stage_download; stage_abliterate; stage_merge; stage_package
              say "built. Run '$0 verify' then '$0 activate' to switch cleetusd over." ;;
  *) print "usage: $0 [all|download|abliterate|merge|package|verify|activate]"; exit 1 ;;
esac
