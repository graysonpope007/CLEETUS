#!/usr/bin/env node
// bin/job.mjs — the single entry point the ten launch agents call.
//
//   node bin/job.mjs heartbeat        run one
//   node bin/job.mjs --list           what there is
//   node bin/job.mjs --status         when each last ran, and whether it worked
//
// One binary rather than ten scripts. The ten labels and their schedules are
// Grayson's and they stay in launchd where he can see them; what they point at
// is one file that cannot go missing without the whole daemon going missing
// with it. The previous arrangement had ten separate paths, any one of which
// could vanish alone — and all ten did, into a deleted worktree.
//
// EXIT CODE IS THE VERDICT. launchd records it, the doctor reads the log, and a
// job that failed exits 1 rather than printing a sad sentence and exiting 0.

import { JOBS, runJob, jobHistory } from "../src/jobs.mjs";

import { localStamp } from "../src/when.mjs";
const arg = process.argv[2];

if (!arg || arg === "--list" || arg === "-l") {
  const hist = await jobHistory();
  console.log("cleetusd jobs\n");
  for (const [id, j] of Object.entries(JOBS)) {
    const h = hist[id];
    const when = h ? `${h.ok ? "ok" : "FAILED"} ${localStamp(h.at)}` : "never run";
    console.log(`  ${id.padEnd(22)} ${when.padEnd(24)} ${j.what}`);
  }
  console.log(`\n  node bin/job.mjs <id>`);
  process.exit(0);
}

if (arg === "--status" || arg === "-s") {
  const hist = await jobHistory();
  const rows = Object.keys(JOBS).map((id) => ({ id, ...(hist[id] || {}) }));
  console.log(JSON.stringify(rows, null, 2));
  // Not an error if a job has simply never run — a fresh install has ten of
  // those and exiting 1 on it would make the first health check red for a
  // reason that is not a fault.
  process.exit(rows.some((r) => r.ok === false) ? 1 : 0);
}

const out = await runJob(arg);
console.log(`${out.ok ? "ok" : "FAILED"} ${out.id}: ${out.summary}`);
process.exit(out.ok ? 0 : 1);
