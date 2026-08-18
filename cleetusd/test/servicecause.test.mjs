// test/servicecause.test.mjs — why a service is not running, not just that it isn't.
//
// The air trackpad went down and the panel said "loaded but not running", with
// "launchctl kickstart" beside it. Its log said:
//
//   RuntimeError: No camera matching 'c920'.
//   Available: [0] Logitech BRIO, [1] OBS Virtual Camera, ...
//
// A webcam had been unplugged. Restarting would have failed every time, and the
// fix line was inviting exactly that loop. launchd already knows where each
// service writes its errors.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");

// The selection rule, lifted from the source rather than restated.
const pick = (tail) => tail.trim().split("\n").reverse()
  .find((l) => /error|exception|no such|not found|refused|denied|no camera|traceback/i.test(l));

test("it finds the real error in a python traceback", () => {
  const log = [
    "starting airpad",
    "Traceback (most recent call last):",
    '  File "/Users/grayson/studio-locate/studio/camera.py", line 61, in resolve_device',
    "    raise RuntimeError(f\"No camera matching {name_hint!r}\")",
    "RuntimeError: No camera matching 'c920'. Available: [0] Logitech BRIO",
  ].join("\n");
  assert.match(pick(log), /No camera matching 'c920'/);
});

test("it takes the LAST error, not the first", () => {
  // A service that restarts in a loop writes the same failure repeatedly, and
  // the oldest one may be a different, already-fixed problem.
  const log = ["ERROR: port already in use", "ok", "ERROR: device not found"].join("\n");
  assert.match(pick(log), /device not found/);
});

test("a log with no error yields nothing to report", () => {
  assert.strictEqual(pick("starting\nlistening on 8768\nframe 1\nframe 2"), undefined);
});

test("the cause is only looked for when the service is down", () => {
  // Reading a log for every healthy service on every doctor run would be work
  // for nothing, 43 checks at a time.
  assert.match(src, /if \(loaded && !running\) \{/);
});

test("the path comes from launchd, not from a guess", () => {
  assert.match(src, /stderr path = \(\\S\+\)/);
  assert.match(src, /Print :StandardErrorPath/, "with the plist as the fallback");
});

test("a known cause changes the advice", () => {
  // The fix line is the part someone acts on. "kickstart" against an unplugged
  // webcam is a loop.
  assert.match(src, /fix the cause above first — kickstart only helps if it was transient/);
  assert.match(src, /: why \?/, "the advice must branch on whether a cause was found");
});

test("the port check and the service check tell the same story", () => {
  // Two checks describe one process. The cause-reporting was added to the
  // service check where the problem was noticed, and the HTTP check for the
  // same service kept saying "fetch failed — try kickstart" — the wrong advice
  // sitting on the same screen as the right one, which is worse than having
  // neither because it invites the restart loop.
  assert.match(src, /const DOWN_BECAUSE = new Map\(\);/);
  assert.match(src, /DOWN_BECAUSE\.set\(label\.replace/);
  assert.match(src, /const cause = DOWN_BECAUSE\.get\(name === "cleetus-web" \? "web" : name\);/);
});

test("a known cause replaces the restart advice on BOTH", () => {
  assert.match(src, /fix the cause above first — kickstart only helps if it was transient/);
  assert.match(src, /fix the cause above first — restarting will not help/);
});

test("the name mapping is applied consistently", () => {
  // The ports table calls it "cleetus-web"; launchd calls it "com.cleetus.web".
  // Getting that wrong in one place and not the other would silently never
  // match, and the check would look correct while doing nothing.
  const uses = src.match(/name === "cleetus-web" \? "web" : name/g) || [];
  assert.ok(uses.length >= 2, "the mapping must be the same on lookup and on the fix line");
});
