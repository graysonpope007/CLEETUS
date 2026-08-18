// test/scheduledjobs.test.mjs — knowing its own routine without excavating for it.
//
// Asked "what do you do automatically on a schedule?", Cleetus answered correctly
// — by spending all twenty of its tool calls reading launchd plists one at a
// time, hitting the ceiling, and finishing with the truncation marker. It also
// misstated the health log path along the way.
//
// The registry has a description for every job and jobHistory() has the last run
// of each. Both were already exported. The answer cost twenty calls because
// nothing connected them to the model; it now costs one.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withAgents(plists) {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  for (const [name, body] of Object.entries(plists)) {
    writeFileSync(join(home, "Library", "LaunchAgents", name), body);
  }
  const script =
    `const m = await import(${JSON.stringify(new URL("../src/tools/work.mjs", import.meta.url).href)});` +
    `process.stdout.write(String(await m.workTools.scheduled_jobs.run({})));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  rmSync(home, { recursive: true, force: true });
  return out;
}

const interval = (secs) => `<plist><dict><key>StartInterval</key><integer>${secs}</integer></dict></plist>`;
const calendar = (h, m) =>
  `<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>${h}</integer>` +
  `<key>Minute</key><integer>${m}</integer></dict></dict></plist>`;

test("every job in the registry is listed with what it does", () => {
  const out = withAgents({});
  assert.match(out, /scheduled jobs:/);
  for (const id of ["heartbeat", "briefing", "nightly-consolidation", "vault-sync", "reindex"]) {
    assert.match(out, new RegExp(`- ${id} `), `${id} missing`);
  }
  assert.match(out, /Notices what needs attention/, "the registry's own description should be used");
});

test("an interval schedule is reported in human units", () => {
  const out = withAgents({ "com.cleetus.heartbeat.plist": interval(1800) });
  assert.match(out, /heartbeat \(every 30m\)/);
});

test("hours are not reported as 60m", () => {
  const out = withAgents({ "com.cleetus.vault-sync.plist": interval(3600) });
  assert.match(out, /vault-sync \(every 1h\)/);
});

test("a calendar schedule is reported as a time of day", () => {
  const out = withAgents({ "com.cleetus.briefing.plist": calendar(7, 0) });
  assert.match(out, /briefing \(daily at 07:00\)/);
});

test("a job with no launch agent is named as unscheduled, not skipped", () => {
  // Silently omitting it is how ten dead agents went unnoticed for three months.
  const out = withAgents({});
  assert.match(out, /not scheduled \(no launch agent\)/);
});

test("jobs that have never run say so, and are counted", () => {
  // "Never run" is the state that hid a broken morning brief. It has to be
  // stated as a fact, not left as an absence for the model to interpret.
  const out = withAgents({});
  assert.match(out, /never run/);
  assert.match(out, /have never run\. That is a fact about this machine, not a guess\./);
});

test("the description steers away from re-reading the plists", () => {
  const src = readFileSync(new URL("../src/tools/work.mjs", import.meta.url), "utf8");
  assert.match(src, /Do NOT /);
  assert.match(src, /reconstruct this by reading plists/);
});
