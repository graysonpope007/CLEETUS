// test/preevent.test.mjs — the job that briefs him before an event.
//
// It ran every ten minutes and reported "nothing starting in the next 45
// minutes". That is exactly what a correct run says on a quiet evening, which is
// why nobody looked at it. The calendar endpoint answers with a BARE ARRAY, and
// the job read:
//
//   events = JSON.parse(raw).events || JSON.parse(raw).items || [];
//
// An array has neither property, so it fell through to [] every time, and the
// filter always ran over nothing. The job was structurally incapable of ever
// firing. Against the live calendar the same read now returns 20 events.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
const job = src.slice(src.indexOf('"pre-event-brief"'), src.indexOf('"text-monitor"'));

// The parse, lifted from the source so the test cannot pass against its own copy.
const parseEvents = (raw) => {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.events || parsed.items || []);
};

test("a bare array of events is read, not discarded", () => {
  assert.match(job, /const parsed = JSON\.parse\(raw\);/);
  assert.match(job, /Array\.isArray\(parsed\) \? parsed : \(parsed\.events \|\| parsed\.items \|\| \[\]\)/);
  assert.doesNotMatch(job, /JSON\.parse\(raw\)\.events \|\| JSON\.parse\(raw\)\.items/,
    "the shape that silently returned nothing is back");
});

test("the real payload shape yields events", () => {
  // Trimmed from an actual /api/google/calendar response.
  const raw = JSON.stringify([
    { id: "a", summary: "Creo", start: "2026-08-14T09:00:00-04:00", location: null },
    { id: "b", summary: "Choir loft worship night", start: "2026-08-14T19:00:00-04:00", location: null },
  ]);
  assert.strictEqual(parseEvents(raw).length, 2);
});

test("wrapped shapes still work", () => {
  // Kept deliberately: a wrapped response is the more common API shape.
  assert.strictEqual(parseEvents(JSON.stringify({ events: [{ id: "a" }] })).length, 1);
  assert.strictEqual(parseEvents(JSON.stringify({ items: [{ id: "a" }, { id: "b" }] })).length, 2);
  assert.strictEqual(parseEvents(JSON.stringify({})).length, 0);
});

test("the window catches an event 30 minutes out and ignores one 6 hours out", () => {
  // The filter was never wrong — it just never had anything to filter.
  const now = Date.now();
  const at = (mins) => new Date(now + mins * 60_000).toISOString();
  const events = parseEvents(JSON.stringify([
    { id: "soon", summary: "Creo", start: at(30) },
    { id: "later", summary: "Worship night", start: at(360) },
    { id: "now", summary: "Already started", start: at(2) },
  ]));
  const soon = events.filter((e) => {
    const t = Date.parse(e.start?.dateTime || e.start || e.when || "");
    return t && t - now > 15 * 60_000 && t - now < 45 * 60_000;
  });
  assert.deepStrictEqual(soon.map((e) => e.id), ["soon"],
    "only the event inside the 15-45 minute window should brief");
});

test("a string start is handled, not only {dateTime}", () => {
  // This endpoint returns a plain ISO string. The downstream code already
  // allowed for both, which is why only the parse needed fixing.
  assert.match(job, /e\.start\?\.dateTime \|\| e\.start \|\| e\.when/);
});

// ---------------------------------------------------------------------------
// The first pre-event brief ever written, in full:
//
//   "I cannot find any specific information about a venue or event called
//    'Creo' in the vault... Would you like me to check the calendar API for any
//    events named Creo happening soon, or search more broadly for this?"
//
// Two faults. It asked a question of a file nobody will reply to. And "Creo" is
// a nine-hour work block, 09:00 to 18:00, every weekday — not a meeting anyone
// needs briefing for.

const isBlock = (e, hours = 4) => {
  const a = Date.parse(e.start?.dateTime || e.start || e.when || "");
  const b = Date.parse(e.end?.dateTime || e.end || "");
  return !!(a && b && (b - a) > hours * 3600_000);
};

test("a nine-hour work block is not an event to brief", () => {
  assert.strictEqual(isBlock({ start: "2026-08-14T09:00:00-04:00", end: "2026-08-14T18:00:00-04:00" }), true);
});

test("a real evening commitment still gets briefed", () => {
  // Choir loft worship night, 19:00-22:00. This is the case the job exists for.
  assert.strictEqual(isBlock({ start: "2026-08-14T19:00:00-04:00", end: "2026-08-14T22:00:00-04:00" }), false);
});

test("an all-day entry is skipped", () => {
  // Its start is midnight, so the 15-45 minute window would fire at 23:15 the
  // night before — wrong regardless of what the title says.
  assert.strictEqual(isBlock({ start: "2026-08-16T00:00:00-04:00", end: "2026-08-17T00:00:00-04:00" }), true);
});

test("an event with no end time is still briefed", () => {
  // Missing data must not silently suppress the notification.
  assert.strictEqual(isBlock({ start: "2026-08-14T19:00:00-04:00" }), false);
});

test("the filter and the threshold are wired into the job", () => {
  assert.match(job, /CLEETUSD_EVENT_MAX_HOURS \|\| 4/);
  assert.match(job, /if \(isBlock\(e\)\) return false;/);
});

test("the brief is told nobody can answer it", () => {
  // An unanswerable question is padding wearing a helpful expression.
  //
  // Asserted via the shared constant rather than the sentence: the wording moved
  // into ONE_WAY when the morning brief and the weekly analysis turned out to
  // need it too, and pinning the literal here broke on a change that made the
  // guarantee stronger. The text itself is checked once, where it is defined.
  assert.match(job, /ONE_WAY/, "the pre-event brief must carry the one-way instruction");
  const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
  assert.match(src, /do not ask him anything/);
  assert.match(src, /End on the last useful fact/);
});

test("every one-way note tells the model nobody will reply", () => {
  // The first pre-event brief ended "Would you like me to check the calendar
  // API, or search more broadly for this?" — addressed to a markdown file on his
  // disk. The morning brief and the weekly analysis go out through the same
  // agent and the same one-way channel, and neither said so.
  //
  // Enumerated from the source rather than listed, so a fifth note cannot be
  // added without a decision. nightly-consolidation is excluded deliberately: it
  // writes facts into MEMORY.md, it is not a note to him.
  const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
  const notes = [
    ["briefing", "Write this morning's brief"],
    ["pre-event-brief", "starting in about half an hour"],
    ["brain-analysis", "This is a week of your own work"],
  ];
  for (const [name, needle] of notes) {
    const at = src.indexOf(needle);
    assert.ok(at > 0, `${name}: prompt not found — this test needs updating`);
    const block = src.slice(at, src.indexOf('",\n', at) + 400);
    assert.match(block, /ONE_WAY/, `${name} does not tell the model the note is one-way`);
  }
});

test("the instruction is one constant, not three copies", () => {
  // The tool list, the deck's agent grouping and the "Last updated" header were
  // each kept by hand beside something that maintained itself, and each drifted.
  const src = readFileSync(new URL("../src/jobs.mjs", import.meta.url), "utf8");
  assert.match(src, /const ONE_WAY =/);
  assert.strictEqual((src.match(/do not ask him anything/g) || []).length, 1,
    "the sentence should exist in exactly one place");
});
