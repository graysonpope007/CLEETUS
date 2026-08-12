#!/usr/bin/env node
// bin/doctor.mjs — print the health report.
//
//   node bin/doctor.mjs          check and report
//   node bin/doctor.mjs --quiet  print only failures (for a cron)
//
// The checks themselves live in src/doctor.mjs so the dashboard can run the
// same ones. Why they exist is documented there; this file only formats.

import { runDoctor } from "../src/doctor.mjs";

const QUIET = process.argv.includes("--quiet");
const { results, failed } = await runDoctor();

if (!QUIET) {
  const byArea = {};
  for (const r of results) (byArea[r.area] ||= []).push(r);
  for (const [area, rows] of Object.entries(byArea)) {
    console.log(`\n${area}`);
    for (const r of rows) {
      const mark = r.skipped ? "--  " : r.ok ? "ok  " : "FAIL";
      const detail = r.skipped ? `(${r.detail}; skipped)` : r.detail;
      console.log(`  ${mark} ${r.name.padEnd(42)} ${detail}`);
    }
  }
}

if (failed.length) {
  console.log(`\n${failed.length} problem${failed.length > 1 ? "s" : ""}:`);
  for (const r of failed) {
    console.log(`  ${r.area}: ${r.name}`);
    console.log(`    ${r.detail}`);
    if (r.fix) console.log(`    fix: ${r.fix}`);
  }
} else if (!QUIET) {
  const ran = results.filter((r) => !r.skipped).length;
  console.log(`\n${ran} checks, all clear.`);
}

process.exit(failed.length ? 1 : 0);
