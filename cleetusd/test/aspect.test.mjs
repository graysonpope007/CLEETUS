// test/aspect.test.mjs — the shape, when nobody said what the shape should be.
//
// A contradiction that sat in plain sight. His brief says it twice — "Otherwise
// assume 4:5", and "square only when square is genuinely what it is for; square
// is the default and it is the wrong shape for most photographs of people" —
// and the code, handed no aspect, rendered 1024x1024.
//
// So the documented rule and the machine disagreed, and the machine won every
// time the model forgot the parameter. bin/image-behaviour-check.mjs caught it
// forgetting twice in one evening: a woman in a gym, and a red cube.
//
// The instruction was already there and already emphatic, so a firmer one was
// not the answer. Forgetting should land on his stated default instead of on
// the shape he has twice written down as wrong.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import { inferAspect } from "../src/aspect.mjs";

const mediaSrc = readFileSync(new URL("../src/tools/media.mjs", import.meta.url), "utf8");

test("the use he named decides it, before anything else does", () => {
  // "a story graphic of a woman" is 9:16 because he said story, even though
  // there is a person in it. The use is more specific than the subject.
  for (const [prompt, want] of [
    ["a story graphic for friday's show", "tall"],
    ["a reel cover with the band on it", "tall"],
    ["album cover art for a southern soul record", "square"],
    ["a logo for magnolia booking", "square"],
    ["a web hero of a mountain range", "wide"],
    ["a youtube thumbnail of the studio", "wide"],
    ["an instagram feed post of a coffee shop", "portrait"],
  ]) {
    assert.equal(inferAspect(prompt)?.aspect, want, `"${prompt}"`);
  }
});

test("a person in a scene is still a photograph of a person", () => {
  // The single most common framing mistake there is: "a bassist on a dim club
  // stage" names a stage, and coming back landscape crops his head off.
  assert.equal(inferAspect("a bassist on a dim club stage, crowd out of focus")?.aspect, "portrait");
  assert.equal(inferAspect("a woman working out at the gym")?.aspect, "portrait");
  assert.equal(inferAspect("a man walking down a city street at midday")?.aspect, "portrait");
});

test("a scene with nobody in it is wider than it is tall", () => {
  assert.equal(inferAspect("an empty beach at sunrise")?.aspect, "landscape");
  assert.equal(inferAspect("a city street at midday")?.aspect, "landscape");
});

test("the fallback is his documented 4:5, never square", () => {
  // Square is not a neutral default. He has written down twice that it is the
  // wrong answer, and the previous behaviour was to pick it whenever nothing
  // else was said.
  const r = inferAspect("a single red cube on a white background");
  assert.equal(r.aspect, "portrait");
  assert.match(r.why, /standing default is 4:5/);
  // And it must never silently answer square by omission.
  assert.notEqual(inferAspect("something with no signal in it at all")?.aspect, "square");
});

test("an empty prompt gets no opinion rather than a guess", () => {
  assert.equal(inferAspect(""), null);
  assert.equal(inferAspect(null), null);
});

test("his explicit aspect always wins, and a reference wins over inference", () => {
  // Two ways the shape is already decided. Inferring over either of them would
  // be exactly the unasked-for variation this whole area is about.
  assert.match(mediaSrc, /const shape = \(!aspect && !reference\) \? inferAspect\(promptUsed\) : null/,
    "inference runs even when he named a shape, or when a reference already has one");
  assert.match(mediaSrc, /const aspectUsed = aspect \|\| shape\?\.aspect \|\| null/,
    "the inferred shape can override the one he asked for");
});

test("choosing the shape for him is said out loud", () => {
  // A silent crop is the most visible unasked-for change there is, and the
  // only reason it is acceptable to choose at all is that declining to choose
  // was also choosing — just choosing worse.
  assert.match(mediaSrc, /He set no shape, so it was rendered/);
  assert.match(mediaSrc, /offer another shape if that is wrong/);
  assert.match(mediaSrc, /\$\{shaped\}/, "the sentence is built but never returned");
});
