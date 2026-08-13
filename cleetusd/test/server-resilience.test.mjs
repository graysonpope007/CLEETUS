// One bad request must not take the assistant down.
//
// It did. The airpad MJPEG proxy sends its 200, pumps frames, and on any error
// during the pump it called res.writeHead(502) — which throws
// ERR_HTTP_HEADERS_SENT once headers are spent. Inside an async handler that
// becomes an unhandled rejection, and Node exits the process. cleetusd died,
// taking three unrelated long-running chat calls with it, because a camera
// hiccupped.
//
// These read the source rather than starting a server: the behaviour under test
// is "does the process survive", and a test that asserts that by crashing the
// runner is not a useful test. The live reproduction is in the handoff.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const src = await readFile(join(import.meta.dirname, "../src/server.mjs"), "utf8");

test("json() is safe to call after a response has begun", () => {
  // Guarded centrally instead of per-catch. Several error paths reach json()
  // when a response is already underway, and a second writeHead there is what
  // killed the process. (A first version of this test scanned catch blocks for
  // writeHead within a fixed window; it flagged a catch whose only sin was
  // calling json(), because the window ran past the end of the block. The
  // window was wrong, but the thing it pointed at was worth fixing.)
  const body = src.slice(src.indexOf("function json("), src.indexOf("async function readBody"));
  assert.match(body, /if \(res\.headersSent\) return res\.end\(\)/);
});

test("raw writeHead in a catch is guarded", () => {
  // json() aside, any direct writeHead in an error path needs the check.
  const rx = /catch[^{]*\{([\s\S]{0,300}?)\n\s*\}/g;
  for (const m of src.matchAll(rx)) {
    const block = m[1];
    if (!/res\.writeHead/.test(block)) continue;
    assert.match(block, /headersSent/, `unguarded writeHead in a catch:\n${block.slice(0, 140)}`);
  }
});

test("the request handler cannot reject into the process", () => {
  // createServer must not be handed a bare async function: its rejection has
  // nowhere to go but the process.
  assert.doesNotMatch(src, /createServer\(async /,
    "an async handler passed straight to createServer exits the process on throw");
  assert.match(src, /handle\(req, res\)\.catch\(/);
});

test("the failure is logged, not swallowed", () => {
  // Surviving is only better than crashing if the fault still shows up.
  const guard = src.slice(src.indexOf("handle(req, res).catch("));
  assert.match(guard.slice(0, 400), /console\.error/);
});
