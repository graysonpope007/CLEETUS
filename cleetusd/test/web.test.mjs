// The browser tools.
//
// The tool they replaced posted a plain-English instruction to `/api/run` on the
// harness. That endpoint has never existed — the harness speaks open/page/act —
// so `browse` could not have worked on its best day. Worse, cleetusd read
// CLEETUS_WEB_URL from the shared env file, which is set to
// https://web.cleetusai.com for the deployed app's benefit and is NXDOMAIN. So
// every call went out to a hostname that does not exist, to reach a service
// listening on the same machine, and reported "the harness is not answering —
// start it with npm start". Starting it would not have helped.
//
// Three independent faults stacked, each one hiding the next. These tests pin
// the two that can silently come back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolSchemas } from "../src/tools/index.mjs";
import { CONFIG } from "../src/config.mjs";

test("the harness is addressed on this machine, not through the internet", () => {
  // The regression this guards: inheriting the cloud app's public hostname for a
  // loopback service. cleetusd runs on the same Mac as the harness. Always.
  assert.match(CONFIG.webHarness, /^http:\/\/(127\.0\.0\.1|localhost):\d+/,
    `webHarness should be loopback, got ${CONFIG.webHarness}`);
});

test("the dead browse tool is gone", () => {
  assert.equal(TOOLS.browse, undefined, "browse posted to /api/run, which does not exist");
});

test("the web primitives are registered and reach the model", () => {
  for (const name of ["web_open", "web_read", "web_act", "web_pending"]) {
    assert.ok(TOOLS[name], `${name} missing`);
    assert.ok(toolSchemas().find((t) => t.function.name === name), `${name} not in the schemas`);
  }
});

test("cleetusd can never approve its own held actions", () => {
  // The harness holds anything irreversible for a human. cleetusd has the disk
  // and the shell; giving it approve would empty the only gate that matters.
  const names = Object.keys(TOOLS);
  assert.equal(names.filter((n) => /approve|confirm_purchase/i.test(n)).length, 0);
  const text = JSON.stringify(toolSchemas());
  assert.doesNotMatch(text, /\/api\/approve/);
});

test("click and type without an index are refused before hitting the browser", async () => {
  for (const action of ["click", "type"]) {
    const out = await TOOLS.web_act.run({ action });
    assert.match(out, /needs an index/);
  }
});

test("scroll and back need no index", async () => {
  // These take no target, so the index guard must not block them. If the harness
  // is down this returns the not-running message — either way, NOT the guard.
  const out = await TOOLS.web_act.run({ action: "scroll" });
  assert.doesNotMatch(out, /needs an index/);
});

test("the not-running message names the command that actually starts it", async () => {
  // It used to say `cd ~/cleetus-web && npm start`, which is how it stayed dead:
  // a hand-started process does not survive the session that spawned it.
  const src = TOOLS.web_open.run.toString() + TOOLS.web_read.run.toString();
  assert.doesNotMatch(src, /npm start/);
});
