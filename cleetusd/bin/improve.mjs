#!/usr/bin/env node
// bin/improve.mjs — one pass of the self-improvement loop.
//
//   node bin/improve.mjs --dry     find the work, change nothing (start here)
//   node bin/improve.mjs           fix one thing, ship it, revert if health drops
//   node bin/improve.mjs --stop    switch the loop off
//   node bin/improve.mjs --go      switch it back on
//
// Meant to be run on a schedule. Everything it does ends up in
// ~/cleetus-memory/improve-state.json and in a run file.

import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { improveOnce, STOP_FILE } from "../src/improve.mjs";

if (process.argv.includes("--stop")) {
  await writeFile(STOP_FILE, `stopped ${new Date().toISOString()}\n`, "utf8");
  console.log(`Loop off. Delete ${STOP_FILE} or run --go to resume.`);
  process.exit(0);
}
if (process.argv.includes("--go")) {
  if (existsSync(STOP_FILE)) await unlink(STOP_FILE);
  console.log("Loop on.");
  process.exit(0);
}

const out = await improveOnce({ dry: process.argv.includes("--dry") });
console.log(JSON.stringify(out, null, 2));
