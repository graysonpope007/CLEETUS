#!/usr/bin/env node
// bin/teach.mjs — hand a failure to the teacher and keep what comes back.
//
//   node bin/teach.mjs "close the books for July" "It guessed at the numbers instead of pulling the ledger"
//   node bin/teach.mjs --agent skin "recommend a routine" "It suggested three new actives at once"

import { teach, teacherEnabled, teacherModel } from "../src/teacher.mjs";

const argv = process.argv.slice(2);
let agent = "cleetus";
const i = argv.indexOf("--agent");
if (i !== -1) { agent = argv[i + 1]; argv.splice(i, 2); }

const [task, whatHappened] = argv;
if (!task || !whatHappened) {
  console.error('usage: node bin/teach.mjs [--agent <id>] "<what it was asked>" "<what went wrong>"');
  process.exit(1);
}

if (!teacherEnabled) {
  console.error("Teacher is off (CLEETUSD_NO_TEACHER=1, or ANTHROPIC_API_KEY unset).");
  process.exit(1);
}

console.error(`asking ${teacherModel}...`);
const out = await teach({ task, whatHappened, agent });

if (!out.ok) { console.error("failed: " + out.reason); process.exit(1); }
if (!out.saved) { console.error("nothing saved: " + out.reason); process.exit(0); }

console.log(`Saved "${out.title}"\n  ${out.path}\n  why it failed: ${out.why}\n  taught by: ${out.servedBy}`);
