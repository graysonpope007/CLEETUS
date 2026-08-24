#!/usr/bin/env node
// ruview-truth.mjs: record VERIFIED ground truth about the room, separately
// from the collector's inferred label.
//
// The collector labels from HID idle time, which answers "is he touching the
// keyboard". That is a good proxy for AT DESK and a bad one for EMPTY ROOM:
// every minute spent reading on the bed, or asleep, or downstairs, lands in the
// same "away" bucket. 200,000 of the 215,000 rows collected so far carry that
// label, and it is the weakest part of the dataset.
//
// A window a human asserts is EMPTY is a clean negative class, which is the one
// thing the data has never had. This file records those assertions with their
// source, so the analyser can weight a verified window differently from an
// inferred one.
//
//   ruview-truth.mjs begin empty   "Grayson away from the house"
//   ruview-truth.mjs end
//   ruview-truth.mjs status
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FILE = join(homedir(), "cleetusd", "roomwatch", "ruview-truth.jsonl");
const [, , cmd, state, ...noteParts] = process.argv;
const note = noteParts.join(" ");

function read() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8").split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
const open = () => read().filter(r => r.event === "begin")
  .filter(b => !read().some(e => e.event === "end" && e.t > b.t)).pop();

if (cmd === "begin") {
  if (!["empty", "occupied"].includes(state))
    { console.error("state must be empty or occupied"); process.exit(2); }
  const cur = open();
  if (cur) { console.error(`already inside a '${cur.state}' window opened ${new Date(cur.t * 1000).toLocaleString()}. End it first.`); process.exit(2); }
  const row = { event: "begin", state, t: Date.now() / 1000, note, source: "human" };
  appendFileSync(FILE, JSON.stringify(row) + "\n");
  console.log(`marked ${state.toUpperCase()} from ${new Date(row.t * 1000).toLocaleTimeString()}${note ? `  (${note})` : ""}`);
} else if (cmd === "end") {
  const cur = open();
  if (!cur) { console.error("no window is open"); process.exit(2); }
  const row = { event: "end", state: cur.state, t: Date.now() / 1000, note, source: "human" };
  appendFileSync(FILE, JSON.stringify(row) + "\n");
  const mins = (row.t - cur.t) / 60;
  console.log(`closed ${cur.state.toUpperCase()} window after ${mins.toFixed(1)} min`);
} else {
  const rows = read();
  const cur = open();
  console.log(`${rows.length} marker(s) in ${FILE}`);
  // Pair them up so the total verified time is visible at a glance.
  let total = {}, start = null;
  for (const r of rows) {
    if (r.event === "begin") start = r;
    else if (start) { total[start.state] = (total[start.state] || 0) + (r.t - start.t); start = null; }
  }
  for (const [k, v] of Object.entries(total)) console.log(`  ${k}: ${(v / 60).toFixed(1)} min closed`);
  if (cur) {
    const mins = (Date.now() / 1000 - cur.t) / 60;
    console.log(`  OPEN NOW: ${cur.state} for ${mins.toFixed(1)} min${cur.note ? `  (${cur.note})` : ""}`);
  } else console.log("  no window open");
}
