#!/usr/bin/env node
// bin/image-adherence-check.mjs — how much of what he said actually survives?
//
//   node bin/image-adherence-check.mjs          5 samples
//   N=12 node bin/image-adherence-check.mjs     12 samples
//
// The behaviour check next door asks whether the agent reaches for the right
// TOOL. This asks a different question: given one hard instruction, how many
// of its parts come out the other end, and how much did the model add. It is a
// rate, sampled, because one pass of a stochastic model proves nothing and
// two passes of it prove nothing twice.
//
// The probe is deliberately harder than the behaviour check's cases: four
// explicit constraints and one exclusion, inside a sentence that also says to
// add nothing. Every part is checkable in the arguments handed to the sampler.
//
// WHAT IT MEASURED, 2026-08-19, and the answer was not the one expected.
// Trimming the repo roster out of the image agent's system prompt took it from
// ~7,600 tokens to ~5,100. Five samples each way:
//
//     fat prompt   constraints kept 5.00/5   invented 0.00
//     lean prompt  constraints kept 5.00/5   invented 0.00
//
// No difference. The trim stands on token cost and latency, and on a picture
// agent having no business reading a list of git repositories — NOT on
// adherence, which is where it was expected to show up. Recorded here rather
// than dropped, because a measurement that fails to support the change is the
// one most worth keeping: without it the claim would have drifted into "we
// made it follow instructions better", which nothing here demonstrates.
//
// The real headline is the number itself. Ten runs out of ten kept every one
// of five constraints and invented nothing, which is a different machine from
// the one that answered a request about a bassist with a woman on a beach
// earlier the same night. If that number ever falls, the causes to look at
// first are the agent memory files and whatever else is being injected into
// the prompt — both of which have caused exactly this, both measured tonight.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.env.N || 5);
const dir = mkdtempSync(join(tmpdir(), "adh-"));
const LOG = join(dir, "c.log");
const STUB = join(dir, "p.sh");
writeFileSync(STUB, `#!/bin/sh
printf '%s\\0' "$@" >> "${LOG}"
printf '\\n---\\n' >> "${LOG}"
for a in "$@"; do case "$prev" in --out) OUT="$a";; esac; prev="$a"; done
[ -n "$OUT" ] && : > "$OUT"
echo '{"ok":true,"kind":"image","path":"'"\${OUT:-/tmp/s.png}"'","model":"realvis","steps":30,"width":832,"height":1216,"guidance":4.5,"negative_applied":true,"prompt_used":"s","long_prompt":null,"seed":1,"seconds":0.1,"reference":null,"strength":null}'
`);
chmodSync(STUB, 0o755);
process.env.CLEETUSD_MEDIA_PYTHON = STUB;
process.env.CLEETUSD_MEDIA_OUT = join(dir, "out");
mkdirSync(process.env.CLEETUSD_MEDIA_OUT, { recursive: true });

const { ask } = await import("../src/agent.mjs");

const ASK = "make exactly this and nothing more: a single blue chair on a bare concrete floor, " +
            "no windows, shot from straight on";

const argOf = (a, f) => { const i = a.indexOf(f); return i === -1 ? "" : a[i + 1]; };

function score(argv) {
  const call = argv[0];
  if (!call) return null;
  const p = (argOf(call, "--prompt") || "").toLowerCase();
  const neg = (argOf(call, "--negative") || "").toLowerCase();
  // Things he named. Each is one point.
  const kept = {
    blue_chair: /blue/.test(p) && /chair/.test(p),
    concrete: /concrete/.test(p),
    straight_on: /straight[- ]on|head[- ]on|straight ahead|frontal|front[- ]on|eye[- ]level/.test(p),
    windows_out_of_prompt: !/window/.test(p),
    windows_in_negative: /window/.test(neg),
  };
  // Things nobody asked for. Each is one point off.
  const invented = ["plant", "rug", "table", "lamp", "person", "man", "woman", "shadow of",
                    "wall art", "poster", "curtain", "sunlight", "dust motes", "cinematic",
                    "dramatic", "moody", "8k", "hyperdetailed", "vintage", "wooden"]
    .filter((w) => p.includes(w));
  return { kept, invented, prompt: p.slice(0, 110) };
}

async function sample(label) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    writeFileSync(LOG, "");
    try {
      await ask({ history: [{ role: "user", content: ASK }], agent: "image", probe: true, maxSteps: 6 });
    } catch (e) { rows.push(null); continue; }
    const argv = existsSync(LOG)
      ? readFileSync(LOG, "utf8").split("\n---\n").filter((s) => s.trim()).map((c) => c.split("\0").filter(Boolean))
      : [];
    rows.push(score(argv));
  }
  const ok = rows.filter(Boolean);
  const pts = ok.map((r) => Object.values(r.kept).filter(Boolean).length);
  const inv = ok.map((r) => r.invented.length);
  const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : "n/a";
  console.log(`\n${label}  (${ok.length}/${N} produced a call)`);
  console.log(`  constraints kept   ${avg(pts)} / 5`);
  console.log(`  invented elements  ${avg(inv)}`);
  for (const r of ok) {
    const missed = Object.entries(r.kept).filter(([, v]) => !v).map(([k]) => k);
    console.log(`   - kept ${Object.values(r.kept).filter(Boolean).length}/5` +
                (missed.length ? ` missed[${missed.join(",")}]` : "") +
                (r.invented.length ? ` invented[${r.invented.join(",")}]` : ""));
  }
  return { pts, inv };
}

await sample(process.env.LABEL || "sample");
