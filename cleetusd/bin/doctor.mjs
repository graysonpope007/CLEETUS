#!/usr/bin/env node
// bin/doctor.mjs — print the health report.
//
//   node bin/doctor.mjs          check and report
//   node bin/doctor.mjs --quiet  print only failures (for a cron)
//   node bin/doctor.mjs --log    append one line to the health log and exit
//
// The checks themselves live in src/doctor.mjs so the dashboard can run the
// same ones. Why they exist is documented there; this file only formats.

import { runDoctor } from "../src/doctor.mjs";

const QUIET = process.argv.includes("--quiet");
const LOG = process.argv.includes("--log");
const { results, failed } = await runDoctor();

// ── history ─────────────────────────────────────────────────────────────────
// The doctor had no memory. Every run reported the present and forgot it, so
// "how long has Plaid been down" had no answer — the flapping was only visible
// because somebody sat there re-running it by hand for six hours.
//
// One line per run, greppable by check name, so a question about duration is
// answered by reading a file instead of watching.
if (LOG) {
  const { appendFile, readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { CONFIG } = await import("../src/config.mjs");
  const path = join(CONFIG.memoryRoot, "health.log");
  const ran = results.filter((r) => !r.skipped).length;
  // Name the discriminator, not just the check.
  //
  // "integrations healthy" failing says something is down and never says what,
  // which is exactly the question the Plaid flapping needed answered — the
  // whole reason this log exists. Checks whose detail IS the finding get a
  // short suffix; the rest stay bare so lines stay scannable.
  const names = failed
    .map((f) => {
      const n = f.name.replace(/\s+/g, "-");
      const d = (f.detail || "").match(/^down: (.+)$/);
      return d ? `${n}[${d[1].replace(/\s+/g, "")}]` : n;
    })
    .join(" ");
  const line = `${new Date().toISOString()}  ${ran - failed.length}/${ran} ok${failed.length ? `  FAIL: ${names}` : ""}\n`;
  await appendFile(path, line, "utf8").catch(() => {});
  // Keep it bounded. At four runs an hour this is about six weeks of history.
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > 4000) await writeFile(path, lines.slice(-3000).join("\n") + "\n", "utf8");
  } catch {}
  process.stdout.write(line);
  process.exit(failed.length ? 1 : 0);
}

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
