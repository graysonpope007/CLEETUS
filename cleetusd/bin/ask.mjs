#!/usr/bin/env node
// bin/ask.mjs — talk to Cleetus from a terminal without the server running.
//
//   node bin/ask.mjs "what am I lifting today"
//   node bin/ask.mjs --agent skin "my forehead is breaking out again"
//   node bin/ask.mjs --probe "does the keyring refuse to print a secret"
//
// --probe marks the run as the system testing ITSELF rather than something
// Grayson asked for. It stays OUT of the deck's recent work, the weekly
// analysis, the nightly consolidation and his open loops.
//
// The default is deliberately off: this is the CLI for asking a real question,
// and marking those as probes would hide his own history from him. But the four
// other callers of ask() all learned to mark themselves and this one had no way
// to, so every test run from a terminal landed in his activity — which is how
// the weekly analysis came to tell him he kept asking for a secret he had never
// mentioned.

import { ask } from "../src/agent.mjs";

const argv = process.argv.slice(2);
let agent = null;
const i = argv.indexOf("--agent");
if (i !== -1) { agent = argv[i + 1]; argv.splice(i, 2); }
const p = argv.indexOf("--probe");
const probe = p !== -1;
if (probe) argv.splice(p, 1);
const question = argv.join(" ").trim();

if (!question) {
  console.error('usage: node bin/ask.mjs [--agent <id>] [--probe] "your question"');
  process.exit(1);
}

const out = await ask({
  history: [{ role: "user", content: question }],
  agent,
  probe,
  onStep: ({ tool, args }) => console.error(`  · ${tool} ${JSON.stringify(args).slice(0, 120)}`),
});

console.error(`\n[${out.agent}]${out.used.length ? " used: " + out.used.join(", ") : ""}`);
console.log("\n" + out.answer);
console.error(`\nrun: ${out.run}`);
