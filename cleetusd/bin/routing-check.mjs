#!/usr/bin/env node
// bin/routing-check.mjs — does a question still reach its specialist?
//
//   node bin/routing-check.mjs        3 samples per case
//   node bin/routing-check.mjs 5      5 samples per case
//
// WHY THIS IS NOT A SINGLE PASS
// The router is a model. Running each case once produces a number that moves on
// its own: the same benchmark read 8/12 one day and 9/12 the next with a new
// fallback, which looked like a regression and was noise. Asked eight times,
// the "regressed" case answered fashion eight times out of eight.
//
// So every case is sampled N times and reported as a rate. A rate can be
// compared with a rate; a single roll cannot be compared with anything.
//
// WHAT THE NUMBER MEANS
// Exact-match against the expected agent is the weaker signal — several of
// these have two defensible answers ("how much did I bench" is muscle or
// fitness; "the venue deposit" is booking or writing) and the label is one
// person's opinion. FALLBACK RATE is the one that matters: every question that
// lands on the generalist is a question answered without its specialist's
// brief, its memory, or its dossiers, and it looks like a normal answer.

import { route } from "../src/agent.mjs";

const SAMPLES = Number(process.argv[2] || 3);

const CASES = [
  ["my forehead is breaking out again", "skin"],
  ["how much should I set aside for taxes this quarter", "tax"],
  ["what should I wear to the show tonight", "fashion"],
  ["is the fender p-bass cheaper anywhere right now", "deals"],
  ["how much did I bench last week", "fitness"],
  ["is my hair thinning at the temples", "hair"],
  ["what do I owe on the higher ways books", "books"],
  ["draft a reply to the venue about the deposit", "writing"],
  ["what did I eat today", "nutrition"],
  ["should I sell my SPY position", "stocks"],
  ["restyle the deck with a warmer palette", "redesign"],
  ["fix the flight map, it is not drawing aircraft", "builder"],
];

let exact = 0, fellBack = 0, total = 0;
for (const [q, want] of CASES) {
  const got = [];
  for (let i = 0; i < SAMPLES; i++) got.push(await route(q));
  const hits = got.filter((g) => g === want).length;
  const backs = got.filter((g) => g === "cleetus").length;
  exact += hits; fellBack += backs; total += SAMPLES;
  const spread = [...new Set(got)].join("/");
  const mark = backs ? "GENERALIST" : hits === SAMPLES ? "ok        " : "varies    ";
  console.log(`  ${mark} ${String(hits + "/" + SAMPLES).padEnd(5)} ${spread.padEnd(22)} ${q.slice(0, 40)}`);
}

console.log(`\n  exact ${exact}/${total} (${Math.round((exact / total) * 100)}%)`);
console.log(`  fell back to the generalist ${fellBack}/${total} (${Math.round((fellBack / total) * 100)}%)  ← the one that matters`);

// Only the fallback rate gates. Exact-match disagreements between neighbouring
// specialists are opinion, and failing a build over an opinion trains people to
// ignore the check.
process.exitCode = fellBack > total * 0.1 ? 1 : 0;
