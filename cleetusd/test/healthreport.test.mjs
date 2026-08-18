// test/healthreport.test.mjs — being able to say what is broken.
//
// Asked "is anything broken with you right now?", Cleetus read log files, found
// the Full Disk Access problem, MISSED the cloud integrations entirely, and
// described the doctor's flags as "likely just informational". They were two
// genuine failures, one of them nine hours old.
//
// The doctor knew all of it — 43 checks every fifteen minutes, written to a log
// — and no tool could reach it. Same shape as recent_work: a question about its
// own state with no source behind it, answered by improvisation.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// os.homedir() honours $HOME on POSIX, which is how the log path is redirected.
function withLog(lines) {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  writeFileSync(join(home, "Library", "Logs", "cleetus-health.log"), lines.join("\n") + (lines.length ? "\n" : ""));
  const script =
    `const m = await import(${JSON.stringify(new URL("../src/tools/work.mjs", import.meta.url).href)});` +
    `process.stdout.write(String(await m.workTools.health_report.run({})));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  rmSync(home, { recursive: true, force: true });
  return out;
}

const line = (iso, ok, fails = "") => `${iso}  ${ok} ok${fails ? `  FAIL: ${fails}` : ""}`;
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test("it names every failing check, not the memorable one", () => {
  // The live failure: it reported the macOS problem and silently dropped the
  // integrations, which had been down for nine hours.
  const out = withLog([line(hoursAgo(0.05), "41/43", "macOS-is-not-refusing-him-anything integrations-healthy[plaid,outlook,push]")]);
  assert.match(out, /macOS is not refusing him anything/);
  assert.match(out, /integrations healthy\[plaid,outlook,push\]/);
  assert.match(out, /2 failing/);
});

test("it says how long each has been failing", () => {
  const out = withLog([
    line(hoursAgo(5), "42/43", "integrations-healthy[outlook]"),
    line(hoursAgo(3), "42/43", "integrations-healthy[outlook]"),
    line(hoursAgo(0.05), "42/43", "integrations-healthy[outlook]"),
  ]);
  // Asserts the DURATION, not the wording around it — the phrase changed from
  // "failing since" to "has been false since" when the framing was fixed, and a
  // test of the sentence would have failed on a change it does not care about.
  assert.match(out, /since \d{4}-\d\d-\d\d \d\d:\d\d/, "a start time should be given");
  assert.match(out, /5 hours ago/, "the streak should reach back to the first consecutive failure");
});

test("a check that recovered and failed again reports the RECENT streak", () => {
  // Otherwise "how long has this been down" answers with an outage that ended.
  const out = withLog([
    line(hoursAgo(9), "42/43", "integrations-healthy[outlook]"),
    line(hoursAgo(8), "43/43"),                                   // recovered
    line(hoursAgo(2), "42/43", "integrations-healthy[outlook]"),  // failed again
    line(hoursAgo(0.05), "42/43", "integrations-healthy[outlook]"),
  ]);
  assert.match(out, /2 hours ago/);
  assert.doesNotMatch(out, /9 hours ago/, "the healed outage must not be reported as ongoing");
});

test("all green says so plainly", () => {
  const out = withLog([line(hoursAgo(0.05), "43/43")]);
  assert.match(out, /Everything the doctor checks is passing/);
});

test("an empty log does not license a guess", () => {
  // The failure being prevented: no data reading as "nothing is wrong".
  const out = withLog([]);
  assert.match(out, /health log is empty/);
  assert.match(out, /nothing is known/);
  assert.match(out, /Say that rather than guessing/);
});

test("it forbids the word that caused this", () => {
  const out = withLog([line(hoursAgo(0.05), "41/43", "integrations-healthy[outlook]")]);
  assert.match(out, /real failures, not warnings/);
  assert.match(out, /Do not describe them as informational/);
});

test("the description sends the model here before it reasons", () => {
  // Matched against runs of text that are contiguous IN THE SOURCE. The
  // description is built by concatenation, so "Call this BEFORE answering 'is
  // anything broken'" is split across two string literals and the readable
  // phrase never appears. Asserting it would have failed forever while the
  // description was perfectly correct.
  const src = readFileSync(new URL("../src/tools/work.mjs", import.meta.url), "utf8");
  assert.match(src, /Call this BEFORE /);
  assert.match(src, /answering 'is anything broken'/);
  assert.match(src, /You cannot tell whether a check is failing by reasoning about it/);
  assert.match(src, /is how a real outage gets called informational/);
});

test("a failing check is framed as a false proposition, not a statement", () => {
  // Checks are NAMED FOR THEIR HEALTHY STATE — "macOS is not refusing him
  // anything", "integrations healthy". Listed as bare failures the names read as
  // claims about the world, and the model repeated one back verbatim:
  //
  //   "macOS is not refusing him anything — been down since yesterday"
  //
  // which asserts the opposite of what is happening. Quoting the name after
  // NOT TRUE makes it a proposition, which is what it actually is.
  const out = withLog([line(hoursAgo(0.05), "41/43", "macOS-is-not-refusing-him-anything")]);
  assert.match(out, /NOT TRUE: "macOS is not refusing him anything"/);
  assert.match(out, /has been false since/);
  assert.doesNotMatch(out, /- macOS is not refusing him anything — failing/,
    "the bare form that reads as a true statement is back");
});

test("the framing is explained, not just applied", () => {
  // The model has to know why the names look inverted, or it will paraphrase
  // them back into statements anyway.
  const out = withLog([line(hoursAgo(0.05), "41/43", "integrations-healthy[outlook]")]);
  assert.match(out, /name describes the HEALTHY state, and it is currently false/);
  assert.match(out, /not repeat a check name back as though it were true/);
});
