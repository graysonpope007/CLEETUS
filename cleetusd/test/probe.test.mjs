// test/probe.test.mjs — the doctor's own local probes.
//
// One probe is one sample. These services do real work — studio-locate decodes
// camera frames — and under load they block past the six-second budget. Twice in
// one session the panel called studio-locate down and it answered in 0.19s when
// asked directly a minute later, both times while this machine was busy running
// the test suite. A check that cries wolf is a check he stops opening.
//
// The distinction being tested: a TIMEOUT is ambiguous and deserves a second
// ask; a REFUSED connection is definitive and must stay fast, so a genuinely
// dead service is still reported promptly.

import { test } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

// Lifted from the real source so the test cannot pass against its own copy.
const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
const body = src.slice(src.indexOf("async function get(url, ms = 6000)"),
                       src.indexOf("// ── launchd agents"));
const get = new Function(`return (${body});`)();

test("a service that blocks once and then answers is not called down", async () => {
  let hits = 0;
  const flaky = createServer((req, res) => {
    hits++;
    if (hits === 1) return;           // hang, exactly like a busy frame decode
    res.writeHead(200); res.end("ok");
  });
  await new Promise((r) => flaky.listen(0, "127.0.0.1", r));
  try {
    const r = await get(`http://127.0.0.1:${flaky.address().port}/`, 400);
    assert.strictEqual(r.status, 200, "the second ask should have succeeded");
    assert.strictEqual(hits, 2, "it must actually ask twice");
  } finally { flaky.close(); }
});

test("a refused connection is reported at once, not retried", async () => {
  // Port 9 (discard) is closed here. If this ever started retrying, a doctor
  // run with several dead services would take twice as long for no information.
  const t0 = Date.now();
  const r = await get("http://127.0.0.1:9/", 400);
  assert.strictEqual(r.status, 0);
  assert.ok(Date.now() - t0 < 350, `took ${Date.now() - t0}ms — a refusal is being retried`);
});

test("a service that is down the whole time is still reported down", async () => {
  // The retry must not turn a real outage into a pass.
  const dead = createServer(() => {});   // never responds
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  try {
    const r = await get(`http://127.0.0.1:${dead.address().port}/`, 200);
    assert.strictEqual(r.status, 0, "two timeouts is still a failure");
    assert.match(r.error, /timeout|abort/i);
  } finally { dead.close(); }
});

test("a healthy service costs exactly one request", async () => {
  let hits = 0;
  const good = createServer((req, res) => { hits++; res.writeHead(200); res.end("ok"); });
  await new Promise((r) => good.listen(0, "127.0.0.1", r));
  try {
    const r = await get(`http://127.0.0.1:${good.address().port}/`, 2000);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(hits, 1, "the retry must not fire on success");
  } finally { good.close(); }
});
