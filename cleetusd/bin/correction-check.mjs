#!/usr/bin/env node
// bin/correction-check.mjs — does a correction actually become a rule?
//
//   node bin/correction-check.mjs        4 samples per case
//   N=8 node bin/correction-check.mjs
//
// The judgement in corrections.mjs is pure and tested in test/. The
// DISTILLATION is a 33B call and cannot be, so it is sampled here — a rate,
// not a pass, because one roll of a model proves nothing and two prove nothing
// twice. Same reason routing-check.mjs and image-behaviour-check.mjs live here.
//
// WHAT THE NUMBER MEANS, and it is not "higher is better" without limit.
// Missing a lesson costs nothing: he corrects the assistant again, and the next
// correction is another chance. Storing a BAD rule costs every future picture,
// because the file is read in full on every message to that agent — which is
// exactly how the image agent came to answer a request about a bassist with a
// woman on a tropical beach. The gate is deliberately biased toward learning
// nothing, so a yield below 100% is the design working, and the case that must
// stay at ZERO is the one that matters most.
//
// Measured 2026-08-20, four samples each:
//     wrong shape        1/4 learned
//     ignored reference  3/4 learned
//     ordinary tweak     0/4 learned   <- must stay 0
//
// It writes into a temp memory root. Nothing here touches his agent files;
// an earlier generation of these checks did, repeatedly, and that is the whole
// reason `probe` now blocks learning at all.

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.env.N || 4);
const root = mkdtempSync(join(tmpdir(), "corrcheck-"));

const turn = (asked, made, correction) => [
  { role: "user", content: asked },
  { role: "assistant", content: made },
  { role: "user", content: correction },
];

const CASES = [
  { name: "wrong shape", expect: "some",
    history: turn("make a cover for the GLM single",
                  "Made a 832x1216 portrait image of an album cover.",
                  "thats not what i asked for, a single cover is square") },
  { name: "ignored the reference", expect: "some",
    history: turn("make this same shot but warmer",
                  "Made a 832x1216 image of a woman in a gym.",
                  "you ignored the picture i gave you") },
  { name: "ordinary tweak", expect: "none",
    history: turn("a picture of a dog", "A golden retriever in a field.", "again, but warmer") },
];

let bad = 0;
for (const c of CASES) {
  const learned = [];
  for (let i = 0; i < N; i++) {
    // A fresh memory root per attempt, so the dedupe check does not hide the
    // rate by refusing the second identical rule.
    process.env.CLEETUS_MEMORY_ROOT = join(root, `${c.name.replace(/\W+/g, "-")}-${i}`);
    mkdirSync(join(process.env.CLEETUS_MEMORY_ROOT, "agents"), { recursive: true });
    const mod = await import(`../src/corrections.mjs?${i}-${Math.random()}`);
    const rule = await mod.captureCorrection({
      agentId: "image", question: c.history[2].content, history: c.history, probe: false,
    }).catch(() => null);
    if (rule) learned.push(rule);
  }
  const ok = c.expect === "none" ? learned.length === 0 : learned.length > 0;
  if (!ok) bad++;
  console.log(`\n${ok ? "ok  " : "FAIL"} ${c.name} — learned ${learned.length}/${N}` +
    (c.expect === "none" ? "  (must be 0)" : ""));
  for (const r of [...new Set(learned)]) console.log(`       ${r}`);
}

console.log(bad
  ? `\n${bad} case(s) behaved wrongly`
  : "\nevery case behaved: real lessons sometimes learned, the tweak never");
process.exit(bad ? 1 : 0);
