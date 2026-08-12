#!/usr/bin/env node
// bin/ask.mjs — talk to Cleetus from a terminal without the server running.
//
//   node bin/ask.mjs "what am I lifting today"
//   node bin/ask.mjs --agent skin "my forehead is breaking out again"

import { ask } from "../src/agent.mjs";

const argv = process.argv.slice(2);
let agent = null;
const i = argv.indexOf("--agent");
if (i !== -1) { agent = argv[i + 1]; argv.splice(i, 2); }
const question = argv.join(" ").trim();

if (!question) {
  console.error('usage: node bin/ask.mjs [--agent <id>] "your question"');
  process.exit(1);
}

const out = await ask({
  history: [{ role: "user", content: question }],
  agent,
  onStep: ({ tool, args }) => console.error(`  · ${tool} ${JSON.stringify(args).slice(0, 120)}`),
});

console.error(`\n[${out.agent}]${out.used.length ? " used: " + out.used.join(", ") : ""}`);
console.log("\n" + out.answer);
console.error(`\nrun: ${out.run}`);
