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
  // Three: the call site, forceGeneration, and writeAndRender. The last two are
  // belt and braces so that adding a second caller cannot route around it.
  assert.strictEqual((agent.match(/mentionsMinor\(/g) || []).length, 5,
    "expected the guard definition plus a check at each of the three entries and the rewrite");
  assert.match(agent, /async function forceGeneration\(\{ question, system, onStep, run \}\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(mentionsMinor\(question\)\) return null;/,
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
