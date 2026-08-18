// test/camerareallyopen.test.mjs — asked-for is not the same as capturing.
//
// With the BRIO physically off the USB bus, the doctor said:
//
//   ok  one camera each   capturing: Logitech BRIO
//
// because that check reads the `-i <device>` argument off the running ffmpeg
// processes — what each service INTENDED to open. ffmpeg was still running and
// still failing.
//
// The service knew, and said so in the same breath:
//
//   {"camera":{"ok":true,"name":"Logitech BRIO",
//              "error":"Video device not found ... Input/output error"}}
//
// ok:true beside a device-not-found error. Both the service and the panel
// reported a healthy camera that was sitting on the desk unplugged.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");

// The rule: a non-empty error field is a failure whatever `ok` claims.
const judge = (camera) => !String(camera?.error || "").trim();

test("ok:true with an error is not ok", () => {
  assert.strictEqual(judge({ ok: true, name: "Logitech BRIO", error: "Video device not found" }), false);
  assert.strictEqual(judge({ ok: true, name: "Logitech BRIO", error: "stream frozen for 10s; restarted" }), false);
});

test("a genuinely open camera passes", () => {
  assert.strictEqual(judge({ ok: true, name: "Logitech BRIO", error: "" }), true);
  assert.strictEqual(judge({ ok: true, name: "Logitech BRIO" }), true);
});

test("whitespace is not an error", () => {
  // An error field of "\n" would otherwise fail a working camera forever.
  assert.strictEqual(judge({ ok: true, error: "\n  " }), true);
});

test("the check reads the service, not the process list", () => {
  // The old check asked ps what ffmpeg was told to do. This one asks the
  // service what happened.
  assert.match(src, /camera is really open/);
  assert.match(src, /\["studio-locate", 8765\], \["airpad", 8768\]/);
  assert.match(src, /JSON\.parse\(st\.body\)\.camera/);
});

test("a service that is down is skipped, not failed", () => {
  // airpad is down with its own cause reported elsewhere. Failing it twice for
  // one problem is noise, and "absent" is not the same as "broken camera".
  assert.match(src, /skip\("cameras", `\$\{svc\} camera is really open`, `\$\{svc\} is not answering`\)/);
});

test("the fix points at the cable, not at a restart", () => {
  assert.match(src, /the camera is not on the bus — check the cable before restarting anything/);
});
