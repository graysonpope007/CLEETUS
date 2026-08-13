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

  // ── NEGATIVE CASES, and the reason they exist ──
  //
  // Every case above has a correct specialist, so a router that forced EVERY
  // question onto SOME specialist scored a perfect 0% fallback here. It did:
  // "is anyone in the room with me" routed to skin, "how much free disk space
  // do I have" to finance, "what have we been talking about" to hair. All
  // answered correctly, because the tools are shared — and all carried the
  // wrong brief and the wrong memory to do it, while the deck printed "working
  // as the skin agent" on screen.
  //
  // A benchmark where the generalist is never the right answer cannot see
  // over-routing at all. These are the questions where cleetus IS correct: the
  // machine, the room, the thread. Being dragged onto a specialist is the
  // failure, and it is scored separately below.
  ["how much free disk space do I have", "cleetus"],
  ["what have we been talking about", "cleetus"],
  ["is cleetusd running", "cleetus"],
  ["what did I ask you yesterday", "cleetus"],
  // The two camera questions were labelled cleetus here at first and the router
  // said studio. The router was right and the label was wrong: studio owns the
  // cameras, the trackpad and the desk light, so "what is on my desk" is its
  // subject and not a stretch. Corrected rather than argued with — a benchmark
  // whose answer key is one person's first guess measures the guess.
  // Two defensible answers, so both are accepted. Labelling these "cleetus"
  // scored the router wrong; relabelling them "studio" scored it wrong the
  // other way, because it genuinely splits between the two run to run. The
  // cameras are studio's subject AND the room is the generalist's territory,
  // and a benchmark that insists on one of those is measuring an opinion.
  ["what is on my desk right now", ["studio", "cleetus"]],
  ["is anyone in the room with me", ["studio", "cleetus"]],
];

// Which of those are the negative ones, for scoring.
// A case is a generalist case when cleetus is among its acceptable answers.
const accepts = (want) => (Array.isArray(want) ? want : [want]);
const GENERALIST = new Set(CASES.filter(([, want]) => accepts(want).includes("cleetus")).map(([q]) => q));

// exactTotal counts EVERY sample; `total` counts only the specialist ones,
// because the fallback rate is meaningless on a case where the generalist is a
// correct answer. Sharing one denominator between them printed "exact 41/36
// (114%)" — the numerator ran over all 18 cases and the denominator over 12.
let exact = 0, exactTotal = 0, fellBack = 0, total = 0, forced = 0, forcedTotal = 0;
for (const [q, want] of CASES) {
  const generalistCase = GENERALIST.has(q);
  const got = [];
  for (let i = 0; i < SAMPLES; i++) got.push(await route(q));
  const ok = accepts(want);
  const hits = got.filter((g) => ok.includes(g)).length;
  const backs = got.filter((g) => g === "cleetus").length;
  exact += hits; exactTotal += SAMPLES;
  // On a case where cleetus is acceptable, landing there is not a fallback —
  // it is one of the right answers, and counting it as a fault is what made
  // the relabelled camera questions read as a 24% regression.
  if (generalistCase) { forced += SAMPLES - hits; forcedTotal += SAMPLES; }
  else { fellBack += backs; total += SAMPLES; }
  const spread = [...new Set(got)].join("/");
  const want_ = ok.join("|");
  // The two faults are opposites and must not share a label. On a specialist
  // question, landing on cleetus is the fault; on a generalist question,
  // landing anywhere else is.
  const bad = generalistCase ? hits < SAMPLES : backs > 0;
  const mark = bad ? (generalistCase ? "STRETCHED " : "GENERALIST")
                   : hits === SAMPLES ? "ok        " : "varies    ";
  console.log(`  ${mark} ${String(hits + "/" + SAMPLES).padEnd(5)} ${spread.padEnd(22)} ${q.slice(0, 40)}`);
}

console.log(`\n  exact ${exact}/${exactTotal} (${Math.round((exact / exactTotal) * 100)}%)`);
console.log(`  fell back to the generalist ${fellBack}/${total} (${Math.round((fellBack / total) * 100)}%)  ← on specialist questions, the one that matters`);
console.log(`  forced onto a specialist ${forced}/${forcedTotal} (${forcedTotal ? Math.round((forced / forcedTotal) * 100) : 0}%)  ← on generalist questions, the same fault backwards`);

// Only the fallback rate gates. Exact-match disagreements between neighbouring
// specialists are opinion, and failing a build over an opinion trains people to
// ignore the check.
// Both directions gate now. Tuning one to zero by sacrificing the other is
// exactly what happened last time, and with only one number on screen it looked
// like an improvement.
process.exitCode = (fellBack > total * 0.1 || forced > forcedTotal * 0.34) ? 1 : 0;
