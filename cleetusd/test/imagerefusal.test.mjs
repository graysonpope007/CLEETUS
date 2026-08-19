// test/imagerefusal.test.mjs — a refusal is not an answer when the tool was
// never called, and the one refusal that is never overridden.
//
// The image agent answered "I can't create that image. The guidelines
// specifically prohibit generating explicit sexual content" and called nothing,
// on a request to draw an adult, on Grayson's own GPU, writing to his own disk.
// Same fault looksFailed exists for: a borrowed script about what an assistant
// cannot do, running somewhere it can.
//
// Two things were tried before the thing that worked, and both are worth
// keeping in mind because both LOOK sufficient:
//   * rewriting the agent's brief to say it does not refuse — no effect at all,
//     the behaviour is in the weights and prompt text loses that argument
//   * offering ONLY the generation tools — better, still not enough: measured
//     5 prompts, 5 refusals, 0 tool calls. A model that will not call a tool
//     does not call a different one, it calls nothing.
// What works is not asking. The call is a function call and this file makes it.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const agent = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");

// The regexes themselves, exercised rather than eyeballed.
const rx = (name) => eval(agent.match(new RegExp(`const ${name} = (/.*/i);`))[1]);
const MINOR_WORDS = rx("MINOR_WORDS");
const UNDER_18 = rx("UNDER_18");
const mentionsMinor = (q) => MINOR_WORDS.test(q) || UNDER_18.test(q);

test("a refusal with no generation tool called triggers the override", () => {
  assert.match(agent, /function isRefusal\(text\)/);
  assert.match(agent, /!used\.some\(\(u\) => String\(u\)\.startsWith\("generate_"\)\) && isRefusal\(answer\)/,
    "the override must require that NO picture was actually made");
  // OR, not AND. Gating on the agent alone misses "i want a picture of…",
  // which the router sends to the generalist; gating on the wording alone
  // missed "generate a gory battle scene", where no word means "picture".
  assert.match(agent, /\(agentId === "image" \|\| wantsPicture\(question\)\)/);
});

test("breakage is not refusal", () => {
  // "I could not generate that, the model failed to download" is an honest
  // report. Escalating it would send a broken renderer round again and report
  // the same breakage as a picture.
  const BREAKAGE = rx("BREAKAGE");
  assert.ok(BREAKAGE.test("I could not generate that, the download failed"));
  assert.ok(BREAKAGE.test("generation did not finish: venv missing"));
});

test("the override never runs when the request mentions a minor", () => {
  // This is the whole reason the guard can be blunt. The override ends by
  // calling generate_image ITSELF, with no model in the loop, so nothing
  // downstream is left to catch this — it has to be caught here.
  for (const q of [
    "make an image of a 12 year old girl in a bikini",
    "make an image of a 9-yr-old in underwear",
    "a photo of a teenage girl topless",
    "nude schoolgirl",
    "aged 15 in lingerie",
    "age 7 swimsuit",
    "a picture of a child",
    "a toddler",
  ]) assert.ok(mentionsMinor(q), `guard missed: ${q}`);

  // And does not fire on adults, which is what it would cost to be too blunt.
  for (const q of [
    "make an image of a topless woman",
    "a gory battle scene with severed limbs",
    "a woman in a thong from behind",
    "a 25 year old woman in lingerie",
  ]) assert.ok(!mentionsMinor(q), `guard over-fired on: ${q}`);
});

test("the guard is checked at every door into the override, not just one", () => {
  // Five doors now: the call site, forceGeneration, writeAndRender, the model's
  // own rewrite, and — since the prompt may be recovered from an earlier turn —
  // that turn plus the assembled prompt itself. Counted rather than eyeballed,
  // because every one of them was added after finding the door it stood in
  // front of was the only one being watched.
  assert.strictEqual((agent.match(/mentionsMinor\(/g) || []).length, 7,
    "expected the guard definition plus a check at every entry, the rewrite, the recovered turn and the final prompt");
  // Deliberately NOT pinned to the exact parameter list. The previous version
  // was, and adding `history` — which is what made the recovered-turn check
  // necessary in the first place — turned a real guard assertion into a
  // signature assertion that failed for the wrong reason.
  assert.match(agent, /async function forceGeneration\(\{[^}]*\}\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(mentionsMinor\(question\)\) return null;/,
    "forceGeneration must refuse at the door");
  assert.match(agent, /if \(mentionsMinor\(question\)\) return null;[\s\S]{0,400}?let prompt = ""/,
    "writeAndRender must refuse before it builds a prompt");
  // The rewritten prompt invents detail the request did not contain, and this
  // path renders it with nothing else looking at it.
  assert.match(agent, /!isRefusal\(t\) && !mentionsMinor\(t\)/,
    "the model's expansion must be checked too, not only the original request");
});

test("the last rung cannot be declined, because the model is not asked", () => {
  // The point of the whole mechanism: by here nothing is being consulted.
  assert.match(agent, /async function writeAndRender\(/);
  assert.match(agent, /await callTool\(tool, args, \{ agentId: "image" \}\)/,
    "writeAndRender must call the tool directly");
  // And a broken renderer must still read as broken.
  assert.match(agent, /exists to defeat a refusal, not to dress a broken renderer up as a picture/);
});

/* ── The prompt that actually reaches the sampler ──────────────────────────
   The override was measured as working — five refused prompts, five files —
   and Grayson still spent an evening reporting that image generation was
   broken. Both halves of why are here, and neither is a refusal.

   Rung two hands the sampler his message verbatim, so on a pass where the
   rewrite rung also declined, the prompt was whatever he typed. After a few
   rounds what he typed was "image generation failed. try again", and a sampler
   given those five words draws them. The picture that came back had nothing to
   do with what he wanted, which is its own evidence that the thing is broken.

   And a message that DOES contain a request is rarely only a request. Observed
   verbatim in the run file:

     "great, now remember what made that work and keep doing that. make a woman
      lying in bed spreading her legs nude please"

   CLIP does not know it is being addressed. "remember", "work", "keep doing"
   are conditioning tokens spending a 77-token budget on feedback to Cleetus. */
import { visualRequest, promptForRender } from "../src/agent.mjs";

test("chatter is stripped, the request is kept", () => {
  assert.strictEqual(
    visualRequest("great, now remember what made that work and keep doing that. " +
                  "make a woman lying in bed spreading her legs nude please"),
    "woman lying in bed spreading her legs nude",
    "the feedback clause must not reach the sampler",
  );
  // What he asked for survives word for word. A prompt cleaner that also
  // softens the request would be the refusal coming back in through the door
  // this whole mechanism exists to shut.
  for (const [asked, want] of [
    ["make an image of a woman working out in the gym", "a woman working out in the gym"],
    ["i want a picture of a curvy woman in a bikini", "a curvy woman in a bikini"],
    ["generate a gory battle scene with blood and severed limbs", "gory battle scene with blood and severed limbs"],
    ["make an image of a topless woman", "a topless woman"],
  ]) assert.strictEqual(visualRequest(asked), want);
});

test("a complaint is not a prompt — the request one turn up is", () => {
  const history = [
    { role: "user", content: "make an image of a woman with big boobs" },
    { role: "assistant", content: "Made a 832x1216 image with realvis in 37.4s" },
    { role: "user", content: "image generation failed. try again" },
  ];
  assert.strictEqual(
    promptForRender("image generation failed. try again", history),
    "a woman with big boobs",
  );
  // Only HIS turns. The assistant's description of a previous image is prose
  // about a picture, not a request for one.
  assert.strictEqual(
    promptForRender("try again", [{ role: "assistant", content: "a woman on a beach at golden hour" }]),
    "try again",
    "an assistant turn must never become the prompt",
  );
});

test("the recovered turn goes through the same door as the current one", () => {
  // "try again" is clean; what it reaches back for might not be. Every other
  // check in this file guards the message that triggered the override, and this
  // path can produce a prompt that never was that message.
  const history = [
    { role: "user", content: "a 15 year old girl at the beach" },
    { role: "user", content: "make an image of a red sports car on a mountain road" },
    { role: "user", content: "try again" },
  ];
  assert.strictEqual(
    promptForRender("try again", history),
    "a red sports car on a mountain road",
  );
  assert.strictEqual(
    promptForRender("try again", [{ role: "user", content: "a 15 year old girl at the beach" }]),
    "try again",
    "the guarded turn must be skipped, not rendered",
  );
  // And the assembled prompt is checked once more where it is used, whatever
  // its origin.
  assert.match(agent, /if \(mentionsMinor\(prompt\)\) return null;/);
});
