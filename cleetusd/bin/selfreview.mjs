#!/usr/bin/env node
// bin/selfreview.mjs — the 04:00 review, by hand.
//
//   node bin/selfreview.mjs --dry     look and propose, ship nothing, publish nothing
//   node bin/selfreview.mjs           the real thing (this is what launchd runs, via
//                                     bin/job.mjs self-improve)
//   node bin/selfreview.mjs --look    the evidence only, no model, no writes
//
// --look exists because the expensive half is the model and the interesting
// half usually is not. "Did it actually see last night's failures" is answerable
// in two seconds, and having to spend a 40-step review to find out is how a
// gatherer that reads the wrong log goes unnoticed.

import { reviewOnce, yesterday, evidenceText } from "../src/selfreview.mjs";

if (process.argv.includes("--look")) {
  const e = await yesterday({});
  console.log(evidenceText(e));
  if (e.blind.length) {
    console.log(`\nCOULD NOT LOOK AT:\n${e.blind.map((b) => `  - ${b}`).join("\n")}`);
  }
  process.exit(0);
}

const out = await reviewOnce({ dry: process.argv.includes("--dry") });
console.log(`\n${out.headline}\n`);
console.log(out.report || "(nothing proposed)");
console.log(`\nwritten to ${out.path}`);
console.log(out.published.ok
  ? "published to the morning brief"
  : `NOT published to the morning brief: ${out.published.reason}`);
