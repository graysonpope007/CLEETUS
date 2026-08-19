// test/longprompt.test.mjs — the words that never reached the sampler.
//
// CLIP's text encoder takes 77 tokens per forward pass. diffusers does not
// error past that, it TRUNCATES, and the only complaint is a transformers
// warning on stderr that nobody reads. So a detailed prompt was rendered from
// its first two thirds and the result was reported as a success, which is the
// exact shape of "it did not make what I asked for": not a model failing to
// understand the words, the words never arriving.
//
// Measured on this machine before the fix, with the real tokenizer:
//
//   a 96-token prompt ending "...cables taped down across the stage, and a
//   bright yellow rubber duck sitting on top of the amplifier"
//
// was cut after "scuffed floorboards". Rendered at seed 42 on realvis it
// contained no duck and no cables. The same prompt and the same seed through
// the chunked encoder contained both.
//
// The tests here are the parts of that which can be asserted without a GPU:
// the windowing itself, and the two properties that make it safe — a short
// prompt is left completely alone, and the prompt and negative prompt always
// come out the same number of windows.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = process.env.CLEETUSD_MEDIA_PYTHON || join(ROOT, "media/.venv/bin/python");
const CLI = join(ROOT, "media_cli.py");
const src = readFileSync(CLI, "utf8");

/** Run a snippet with media_cli imported as a module. Returns parsed stdout JSON. */
function inCli(snippet) {
  const prog = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("mcli", ${JSON.stringify(CLI)})`,
    "m = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(m)",
    snippet,
  ].join("\n");
  return JSON.parse(execFileSync(PY, ["-c", prog], { encoding: "utf8", maxBuffer: 8_000_000 }));
}

const havePy = existsSync(PY);

// ── the windowing ─────────────────────────────────────────────────────────────

test("a long prompt becomes whole 77-token windows, not a truncation", { skip: !havePy && "media venv is not installed" }, () => {
  const r = inCli(`
from transformers import CLIPTokenizer
tok = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
short = "a woman in a red dress"
long_ = "a bassist on a dim club stage, " * 12 + "and a bright yellow rubber duck on the amplifier"
ws = m._chunked_ids(tok, long_)
print(json.dumps({
  "short_windows": len(m._chunked_ids(tok, short)),
  "long_windows": len(ws),
  "widths": sorted(set(len(w) for w in ws)),
  "long_tokens": len(tok(long_, truncation=False).input_ids),
  # Every window has to be a real encoder input: bos at the front, and the tail
  # of the prompt must actually be inside the last one.
  "all_start_bos": all(w[0] == tok.bos_token_id for w in ws),
  "duck_in_last": "duck" in tok.decode([t for t in ws[-1] if t not in (tok.bos_token_id, tok.pad_token_id)]),
}))
`);
  assert.equal(r.short_windows, 1, "a short prompt was split for no reason");
  assert.ok(r.long_windows >= 2, `a ${r.long_tokens}-token prompt came back as ${r.long_windows} window(s)`);
  assert.deepEqual(r.widths, [77], "a window is not 77 wide, so the encoder will reject or pad it silently");
  assert.ok(r.all_start_bos, "a window is missing its start token");
  assert.ok(r.duck_in_last, "the tail of the prompt is not in any window — it is still being dropped");
});

// ── the two safety properties ─────────────────────────────────────────────────

test("a short prompt takes the old path untouched, so saved seeds still reproduce", () => {
  // Every seed Grayson has written down was produced by the string path.
  // Routing short prompts through a different encoding would quietly stop
  // reproducing the pictures those seeds were saved for, and he would have no
  // way to tell that from the model being inconsistent.
  const gate = src.slice(src.indexOf("def _long_prompt_kwargs"), src.indexOf("def _dimensions"));
  assert.match(gate, /if n_prompt <= limit and n_negative <= limit:\s*\n\s*return None, None/,
    "the short-circuit is gone, so every prompt now takes the chunked path");
});

test("prompt and negative prompt always come out the same number of windows", () => {
  // The sampler stacks them into one batch under classifier-free guidance. A
  // ragged pair is a shape error thrown after the model load and the denoise
  // has begun, which is the most expensive place to find out.
  const enc = src.slice(src.indexOf("def _encode_long"), src.indexOf("def _long_prompt_kwargs"));
  assert.match(enc, /want_chunks is not None and len\(windows\) < want_chunks/,
    "nothing pads the shorter side up to the longer one");
  const gate = src.slice(src.indexOf("def _long_prompt_kwargs"), src.indexOf("def _dimensions"));
  assert.match(gate, /want = max\(/, "the common window count is not computed from both sides");
});

test("embeddings and the raw prompt string are never sent together", () => {
  // diffusers refuses the pair rather than picking one, which is correct and
  // which is exactly how this was caught: the first run died with "Cannot
  // forward both `prompt` and `prompt_embeds`" because `prompt` was still in
  // the kwargs dict from the line that builds it.
  const render = src.slice(src.indexOf("def _render"), src.indexOf("def cmd_image"));
  assert.match(render, /kw\.pop\("prompt", None\)/,
    "the raw prompt is still in the kwargs when embeddings are used");
});

test("what had to be done is reported back, not only logged to stderr", () => {
  // The whole reason this was invisible for so long: the truncation warning
  // went to stderr, the tool result said "Made a 832x1216 image", and nobody
  // downstream had any way to know two thirds of the prompt had been used.
  const render = src.slice(src.indexOf("def _render"), src.indexOf("def cmd_image"));
  assert.match(render, /"long_prompt": long_note/, "the result does not carry the note");
  const mediaTool = readFileSync(join(ROOT, "src/tools/media.mjs"), "utf8");
  assert.match(mediaTool, /long_prompt/,
    "the tool never surfaces it, so the agent cannot tell Grayson");
});
