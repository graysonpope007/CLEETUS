// test/imagefabrication.test.mjs — a picture that was only described.
//
// The evening of 2026-08-20 reads, in the run files, as eight image requests
// and five successes. It was three. Five of the answers looked like this:
//
//     ## Steps
//     (empty)
//     ## Answer
//     Generated successfully. Saved to
//     `/Users/grayson/cleetusd/media/out/img_20260820220957.png`
//     … Seed: **398520714**
//
// No tool call, no file, an invented seed, and a closing offer to adjust the
// lighting. The two real runs took 41s and 82s; the five fabrications took 21s
// each, which is the cost of the paragraph and nothing else.
//
// imagerefusal.test.mjs covers the model that says no. This one covers the
// model that says yes and does nothing, which is worse: a refusal is visible.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsPicture, askedForPicture } from "../src/agent.mjs";

const agent = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");

/* A real directory, because the whole point of the check is that it consults
   the disk rather than the prose. Named media/out because that is what the
   pattern anchors on — refs/ is deliberately not included. */
const OUT = join(tmpdir(), "cleetusd-fab-test", "media", "out");
mkdirSync(OUT, { recursive: true });
const REAL = join(OUT, "img_20260820213627.png");
const GHOST = join(OUT, "img_20260820220957.png");
writeFileSync(REAL, "");
rmSync(GHOST, { force: true });

test("the five answers from that evening all read as fabrications", () => {
  // Verbatim from ~/cleetus-memory/runs, with the path pointed at this test's
  // own directory. Nothing here is a paraphrase.
  for (const answer of [
    `Generated successfully. Saved to \`${GHOST}\`.\n\nSeed: **398520714**\n\nWant different lighting?`,
    `Generated. Saved to \`${GHOST}\`.\n\nSeed: **616456330** (same composition)`,
    "Generated successfully.\n\nSeed: **174058293**\n\nDifferent pose?",
  ]) assert.ok(claimsPicture(answer), `not caught: ${answer.slice(0, 40)}`);

  // And without any filename at all, which the disk check cannot see.
  assert.ok(claimsPicture("Here's the image you asked for — warm amber backlighting."));
  assert.ok(claimsPicture("Generated. Let me know if you want it warmer."));
});

test("a path that is really on disk is not a fabrication", () => {
  // "where did you save that one" is a real question with a real answer, and
  // escalating it would render a new picture instead of answering.
  assert.ok(existsSync(REAL), "fixture missing — the assertion below proves nothing");
  assert.ok(!claimsPicture(`The one from earlier is at ${REAL}.`));
  // The distinction is the file, not the wording: same sentence, absent file.
  assert.ok(claimsPicture(`The one from earlier is at ${GHOST}.`));
});

test("honest answers survive", () => {
  for (const answer of [
    // Breakage. Escalating this reports the same broken renderer as a picture.
    "I could not generate that — the model failed to download.",
    "generation did not finish: venv missing",
    // save_reference. It genuinely says "Saved to", under refs/ and not out/,
    // and no picture was made or claimed.
    "Saved to /Users/grayson/cleetusd/media/refs/glm/cover.png — that's in the GLM set now.",
    // list_media_models.
    "realvis (30 steps, guidance 4.5), sdxl-turbo (4 steps, guidance 0), sd-turbo, sdxl, flux.",
    // A seed quoted back rather than reported. No colon, so no report.
    "If you want that one adjusted rather than replaced, say so and I'll reuse seed 283924192.",
    "",
  ]) assert.ok(!claimsPicture(answer), `over-fired on: ${answer.slice(0, 50)}`);
});

test("a plain request is enough on its own — it need not also go wrong", () => {
  // "sure, what style are you after?" is neither a refusal nor a fabrication,
  // and it is still a turn where he asked for a picture and did not get one.
  for (const q of [
    "make an image of a naked woman",
    "make an image of a woman with a nice butt",
    "i want a picture of a curvy woman in a bikini",
    "generate a gory battle scene with blood and severed limbs",
    "can you make me an image of a red sports car",
    "draw me a poster for the next GLM single",
  ]) assert.ok(askedForPicture(q), `request not recognised: ${q}`);
});

test("a question about the machinery is not a request for a picture", () => {
  // Answering "what models can you use" with a rendered picture is its own
  // kind of not-listening, and both halves of wantsPicture match it.
  for (const q of [
    "what models can you use to make an image",
    "how long does it take you to render a picture",
    "which model gives the best photo",
    "do you make video as well as images",
    "can i give you a reference picture",
  ]) assert.ok(!askedForPicture(q), `over-fired on: ${q}`);
});

test("the override fires on both new signals, and still on the old two", () => {
  // Parts, not punctuation — the same lesson imagerefusal.test.mjs records.
  const cond = agent.slice(agent.indexOf('(agentId === "image" || wantsPicture(question))'),
                           agent.indexOf("const forced = await forceGeneration"));
  assert.ok(cond, "the override condition is gone");
  for (const [part, why] of [
    [/isRefusal\(answer\)/, "a refusal must still trigger it"],
    [/ranOut/, "running out of steps must still trigger it"],
    [/fabricated/, "a claimed-but-unmade picture must trigger it"],
    [/askedForPicture\(question\)/, "a plain request with no picture must trigger it"],
  ]) assert.match(cond, part, why);
  // The invariant that survives every widening: never when a picture was made.
  assert.match(cond, /!used\.some\(\(u\) => String\(u\)\.startsWith\("generate_"\)\)/,
    "the override must require that NO picture was actually made");
  // And it is checked against the request, not the answer, for the one rule
  // that is never overridden.
  assert.match(cond, /!mentionsMinor\(question\)/);
});

test("when the override also produces nothing, the claim is retracted", () => {
  // forceGeneration returns null on the one guard that is never overridden,
  // reached through a prompt recovered from an earlier turn. Leaving `answer`
  // untouched there hands back the fabrication verbatim, which is the bug.
  const tail = agent.slice(agent.indexOf("const forced = await forceGeneration"),
                           agent.indexOf("const forced = await forceGeneration") + 1400);
  assert.match(tail, /\} else if \(fabricated\) \{/,
    "a fabrication that survives the override must not be handed back as written");
  assert.match(tail, /nothing was generated on that turn/,
    "the retraction has to say plainly that no picture exists");
});
