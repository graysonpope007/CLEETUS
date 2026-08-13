// The flight sweep's source fallback.
//
// The map was dark and every component reported success. adsb.lol answers HTTP
// 200, `"msg": "No error"`, `"total": 0` — a perfectly well-formed empty list,
// for every anchor on earth. `anchor()` returned on the first source that gave
// an Array, and `[]` is an Array, so the fallbacks were never reached.
//
// Downstream, everything behaved correctly and said nothing useful: the sweeper
// "succeeded" with 0 aircraft, the ingest correctly refused an empty sweep, and
// the endpoint reported `no_adsb_feed_reachable` — true, and naming none of it.
//
// These assert the source list and the fall-through, against the file, because
// exercising anchor() for real would depend on live third-party feeds and pass
// or fail for reasons that have nothing to do with this code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANCHORS } from "../src/flights.mjs";

const src = await readFile(join(import.meta.dirname, "../src/flights.mjs"), "utf8");

test("an empty answer does not end the search", () => {
  // The bug in one line: `if (Array.isArray(ac)) return ...`.
  assert.doesNotMatch(src, /if \(Array\.isArray\(ac\)\) return/,
    "returning on any Array accepts an empty feed and skips every fallback");
  assert.match(src, /if \(aircraft\.length\) return/,
    "a source should only win when it actually produced aircraft");
});

test("a reachable but empty source is distinguished from nobody answering", () => {
  // Genuinely empty sky exists (mid-Pacific, 3am). It must not be reported the
  // same way as every feed being down.
  assert.match(src, /answered \|\|= name/);
  assert.match(src, /return \{ source: answered, aircraft: \[\] \}/);
});

test("adsb.fi is present and tried first", () => {
  // The only one of the three still serving data as of 12 Aug 2026.
  const list = src.slice(src.indexOf("const SOURCES"), src.indexOf("function normalise"));
  const order = [...list.matchAll(/\["([a-z.]+)",/g)].map((m) => m[1]);
  assert.equal(order[0], "adsb.fi", `expected adsb.fi first, got ${order.join(" -> ")}`);
  // The dead ones are kept deliberately: feeds come back, and checking costs
  // one failed request.
  assert.ok(order.includes("adsb.lol"));
  assert.ok(order.includes("airplanes.live"));
});

test("both response shapes are handled", () => {
  // adsb.lol uses `ac`, adsb.fi uses `aircraft`. Reading only one would have
  // made the working feed look empty — which is exactly what my first probe did.
  assert.match(src, /j\.ac \|\| j\.aircraft/);
});

test("the anchor set still covers the planet", () => {
  assert.ok(ANCHORS.length >= 20, `only ${ANCHORS.length} anchors`);
  const lons = ANCHORS.map((a) => a[1]);
  assert.ok(Math.min(...lons) < -100 && Math.max(...lons) > 100, "anchors do not span the globe");
});
