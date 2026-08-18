// test/agentloaded.test.mjs — the difference between stopped and unloaded.
//
// com.cleetus.ollama was not stopped on 14 Aug. It was UNLOADED, and that is a
// different kind of gone: KeepAlive only applies to an agent launchd knows
// about, so nothing restarted it and nothing could. The local model was absent
// for minutes while the plist, the binary and the log all looked perfect.
//
// The doctor already checked that each agent's program exists and that each
// plist parses. Both passed throughout. "Is it loaded" was the question nobody
// was asking, and it is the one that separates a scheduled job sitting idle —
// which is healthy — from a service that will never run again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unloadedAgents } from "../src/doctor.mjs";

// launchctl list is tab-separated PID / status / label, with a header row.
const listing = (labels) =>
  ["PID\tStatus\tLabel", ...labels.map((l, i) => `${100 + i}\t0\t${l}`)].join("\n");

test("an agent on disk and in launchd is fine", () => {
  const out = unloadedAgents(
    ["/Users/x/Library/LaunchAgents/com.cleetus.ollama.plist"],
    listing(["com.cleetus.ollama"]),
  );
  assert.deepEqual(out, []);
});

test("an agent on disk but absent from launchd is reported", () => {
  // The actual 14 Aug state: the plist was there, launchctl had never heard of it.
  const out = unloadedAgents(
    [
      "/Users/x/Library/LaunchAgents/com.cleetus.ollama.plist",
      "/Users/x/Library/LaunchAgents/com.cleetus.cleetusd.plist",
    ],
    listing(["com.cleetus.cleetusd"]),
  );
  assert.deepEqual(out, ["com.cleetus.ollama"]);
});

test("a loaded agent with no PID is loaded, not missing", () => {
  // This is the case that makes the check worth having rather than noisy. Most
  // of these agents are scheduled, so sitting there with a dash for a PID is
  // their normal healthy state — launchd will start them at the next interval.
  // Confusing that with unloaded would light up the report every single run.
  const idle = "PID\tStatus\tLabel\n-\t0\tcom.cleetus.briefing";
  assert.deepEqual(unloadedAgents(["/x/com.cleetus.briefing.plist"], idle), []);
});

test("a negative exit status is still loaded", () => {
  const angry = "PID\tStatus\tLabel\n-\t-9\tcom.cleetus.web";
  assert.deepEqual(unloadedAgents(["/x/com.cleetus.web.plist"], angry), [],
    "a bad last exit is a different problem; the agent is still there");
});

test("system agents in the listing do not mask a missing cleetus agent", () => {
  const out = unloadedAgents(
    ["/x/com.cleetus.ollama.plist"],
    listing(["com.apple.ollama", "com.cleetus.ollamas", "ollama"]),
  );
  assert.deepEqual(out, ["com.cleetus.ollama"], "matching must be exact, not substring");
});

test("empty launchctl output reports everything rather than nothing", () => {
  // If the listing cannot be read, the honest answer is "I cannot see any of
  // these", not silence. Silence here would recreate the exact outage.
  const out = unloadedAgents(["/x/com.cleetus.a.plist", "/x/com.cleetus.b.plist"], "");
  assert.deepEqual(out, ["com.cleetus.a", "com.cleetus.b"]);
});

test("no plists means nothing to report", () => {
  assert.deepEqual(unloadedAgents([], listing(["com.cleetus.ollama"])), []);
});
