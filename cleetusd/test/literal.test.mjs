// test/literal.test.mjs — doing what he said, rather than something better.
//
// The complaint this answers is "make EXACTLY what I say without any
// variation", and the thing that makes it hard is that every variation in this
// codebase was put there on purpose and is right most of the time. The image
// brief turns a rough ask into a concrete visual prompt. writeAndRender
// expands a sentence into pose, clothing, setting, time of day, light, lens.
// media_cli appends a photographic style. None of that is a bug on "make me
// something cool" and all of it is the bug on "a red cube on white, nothing
// else".
//
// So the tests are about the SWITCH, and they are weighted the way the costs
// are weighted. Being literal about a rough ask costs a plainer picture. Being
// creative about a precise one costs the wrong picture and a second message
// saying so — which is the loop he has actually been living in.
//
// The negation tests are the other half, and they are about a property of
// samplers rather than of prompts: cross-attention has no operator for "not".
// Measured here on realvis at seed 11, "a busy city street at midday, no cars"
// rendered a street full of taxis, an SUV and a pickup. The same seed with
// `cars` moved into the negative prompt rendered a pedestrianised street with
// none. The words were never the problem; the input they were put in was.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import { literalMode, literalClause, liftNegations, verbatimText } from "../src/literal.mjs";

const agentSrc = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
const mediaSrc = readFileSync(new URL("../src/tools/media.mjs", import.meta.url), "utf8");
const cliSrc = readFileSync(new URL("../media_cli.py", import.meta.url), "utf8");

// ── the switch ────────────────────────────────────────────────────────────────

test("a rough ask is still expanded, because that is what he wants there", () => {
  // The regression that would matter most and be noticed least: turning the
  // whole assistant literal makes every casual request produce a flatter
  // picture, and nobody files a bug for "slightly duller than last week".
  for (const q of ["make me a picture of a bassist", "draw a dog", "album art for a soul record",
                   "i need a thumbnail for the video", "no rush, make me something cool"]) {
    assert.equal(literalMode(q).level, "open", `"${q}" was treated as literal`);
    assert.equal(literalClause(literalMode(q)), "", `"${q}" got a clause it should not have`);
  }
});

test("quoting a prompt means the prompt is what was quoted", () => {
  const m = literalMode('generate "a lone pine on a granite ridge at dusk"');
  assert.equal(m.level, "verbatim");
  assert.equal(verbatimText('generate "a lone pine on a granite ridge at dusk"', m.quoted),
    "a lone pine on a granite ridge at dusk");
});

test("a verbatim instruction loses the sentence that introduced it", () => {
  // "use this exact prompt: a red cube on white" must render a red cube, not
  // a sentence about prompts. Without this the literal path is worse than the
  // expanding one, which is the failure that would kill the feature.
  for (const [q, want] of [
    ["use this exact prompt: a red cube on a white background", "a red cube on a white background"],
    ["make exactly this: a red cube on a white background", "a red cube on a white background"],
    ["word for word: two chairs facing a window", "two chairs facing a window"],
  ]) {
    const m = literalMode(q);
    assert.equal(m.level, "verbatim", `"${q}" was not read as verbatim`);
    assert.equal(verbatimText(q, m.quoted), want);
  }
});

test("a correction is treated as a correction, not a fresh brief", () => {
  // These sentences only ever get typed after something arrived that he did
  // not ask for. Re-rolling the whole thing is how the same complaint arrives
  // a second time.
  for (const q of ["i didnt ask for a hat", "thats not what i asked for",
                   "you added a bunch of stuff i never said", "i never said anything about a beach"]) {
    const m = literalMode(q);
    assert.notEqual(m.level, "open", `"${q}" was treated as a fresh brief`);
    assert.match(literalClause(m), /correcting|already been specific/i);
  }
});

test("asking twice is itself the signal, without any of the words", () => {
  const history = [{ role: "user", content: "a lone pine on a granite ridge at dusk, cold light" }];
  const m = literalMode("a lone pine on a granite ridge at dusk with cold light", history);
  assert.notEqual(m.level, "open", "the repeat was read as a brand new request");
});

test("the clause never tells it to add nothing and also to add a style", () => {
  // Verbatim means nothing added at all. Literal still lets it choose the
  // light and the lens, because that is how the picture looks rather than what
  // is in it — and a rule that forbade both would produce worse pictures for
  // no gain in fidelity.
  const v = literalClause(literalMode('use this exact prompt: "a red cube on a white background"'));
  assert.match(v, /do not add a single element/i);
  const l = literalClause(literalMode("a red cube on a white background, nothing else"));
  assert.match(l, /how it is lit and shot/i);
});

// ── negations ─────────────────────────────────────────────────────────────────

test("every negation is lifted, not just the last one", () => {
  // The first version required the clause to start with `^ , ; . and but`, so
  // "a city street with no cars and no signage" caught the signage and lost
  // the cars — the word before "no cars" is "with". Half a fix here is worse
  // than none: the picture comes back with cars and the prompt still says no.
  const { terms, cleaned } = liftNegations("a city street with no cars and no signage, wet asphalt");
  assert.deepEqual(terms, ["cars", "signage"]);
  assert.equal(cleaned, "a city street, wet asphalt");

  const many = liftNegations("a forest path, no fog, no birds, no people");
  assert.deepEqual(many.terms, ["fog", "birds", "people"]);
  assert.equal(many.cleaned, "a forest path");
});

test("the negated word leaves the positive prompt entirely", () => {
  // This IS the fix. Leaving `people` in the positive prompt while also
  // putting it in the negative one is two inputs arguing, and the positive one
  // is the one attached to the subject.
  const { cleaned } = liftNegations("a quiet beach at sunrise, no people");
  assert.ok(!/people/i.test(cleaned), `"${cleaned}" still names what he asked to leave out`);
});

test("an instruction to us is not a thing to keep out of the picture", () => {
  // "no rush" in a negative prompt is a small absurdity that costs a slightly
  // worse image for nothing.
  assert.deepEqual(liftNegations("no rush, make me something cool").terms, []);
  assert.deepEqual(liftNegations("no paraphrasing please").terms, []);
});

test("articles are dropped, because a token is a token", () => {
  assert.deepEqual(liftNegations("a portrait of a man, without a hat").terms, ["hat"]);
});

// ── the wiring ────────────────────────────────────────────────────────────────

test("the lift happens at the one door every path goes through", () => {
  // The agent writing its own prompt, the forced generation pass, and the
  // last-resort renderer all end at generate_image. A fix anywhere else is one
  // a fourth path can be added around without noticing.
  assert.match(mediaSrc, /import \{ liftNegations \} from "\.\.\/literal\.mjs"/);
  assert.match(mediaSrc, /const lifted = liftNegations\(String\(prompt\)\)/);
  assert.match(mediaSrc, /lifted\.terms\.length \? lifted\.cleaned/);
});

test("moving his words is said out loud", () => {
  // Silent helpfulness is the thing this whole area is apologising for.
  assert.match(mediaSrc, /Kept out via the negative prompt/);
});

test("the model's tuned negative prompt survives a negative of his own", () => {
  // It was `args.negative or spec.get("negative")`, so any negative at all
  // silently discarded the anti-plastic-skin, anti-bad-hands list that keeps
  // realvis from looking generated. "No people on the beach" therefore also
  // asked for waxy skin back.
  assert.match(cliSrc, /negative = _merge_negative\(args\.negative, spec\.get\("negative"\)\)/);
  assert.ok(!/negative = args\.negative or spec\.get/.test(cliSrc),
    "the replacing form is still in the file");
});

test("his exclusions survive the model rewording them away", async () => {
  /* liftNegations inside generate_image can only see the prompt the MODEL
     wrote, which is one rewrite too late.

     Measured by bin/image-behaviour-check.mjs, and it is the reason this
     function exists. Asked for "an empty beach at sunrise, no people", the
     model wrote "Empty beach at sunrise, soft golden light…" and passed no
     negative prompt at all. It had handled the exclusion by rewording it, so
     there was nothing left to lift, and the sampler was told to avoid nothing.
     "Empty beach" in the positive prompt is a far weaker instrument than
     `people` in the negative one, and the difference is people on the beach. */
  const { insistOnExclusions } = await import("../src/agent.mjs");
  const q = "make me a photo of an empty beach at sunrise, no people";

  const dropped = insistOnExclusions("generate_image", { prompt: "Empty beach at sunrise" }, q);
  assert.equal(dropped.negative, "people", "his exclusion never reached the sampler");

  // ADDITIVE. A model that chose good exclusions of its own keeps all of them.
  const kept = insistOnExclusions("generate_image", { prompt: "beach", negative: "boats, litter" }, q);
  assert.equal(kept.negative, "boats, litter, people");

  // And it does not repeat a term they both thought of — a negative prompt is
  // a token budget like any other.
  const dup = insistOnExclusions("generate_image", { prompt: "beach", negative: "People, boats" }, q);
  assert.equal(dup.negative, "People, boats");

  // Narrow on purpose: not every tool, and nothing when he excluded nothing.
  assert.equal(insistOnExclusions("run_shell", { command: "ls" }, q).negative, undefined);
  assert.equal(insistOnExclusions("generate_image", { prompt: "a dog" }, "make me a dog").negative, undefined);
});

test("the insistence runs on the real tool-call path, not just in isolation", () => {
  // A helper nothing calls is a helper that fixes nothing, and this one sits
  // in the middle of the loop rather than at a door with a test on it.
  /* ORDERING, not adjacency. This pinned the two lines as neighbours across a
     newline, which a single inserted comment breaks while the property holds.
     What matters is that the exclusions go in BEFORE the tool runs. */
  /* The LAST tool loop, not the first. agent.mjs has two — forceGeneration has
     its own, and it comes first in the file — so indexOf sliced the wrong one
     and the assertion failed against code that was perfectly correct. Fourth
     time in this repo a window has read something it was not looking at, and
     the note about the previous three is in doctor.mjs. */
  const loop = agentSrc.slice(agentSrc.lastIndexOf("for (const call of res.toolCalls)"));
  const insistAt = loop.indexOf("insistOnExclusions(name, args, question)");
  const runAt = loop.indexOf("await callTool(name, args");
  assert.ok(insistAt !== -1, "insistOnExclusions is never called on the real tool path");
  assert.ok(runAt !== -1 && insistAt < runAt,
    "the exclusions are added after the tool has already run, which is too late");
});

test("the expansion rung is skipped when he has already been specific", () => {
  const wr = agentSrc.slice(agentSrc.indexOf("async function writeAndRender"),
                            agentSrc.indexOf("async function renderPrompt"));
  assert.match(wr, /const mode = literalMode\(question, history\)/);
  assert.match(wr, /mode\.level === "verbatim"/, "a quoted prompt still goes through the rewriter");
  assert.match(wr, /mode\.level === "literal"/, "a constrained ask still goes through the rewriter");
  // The rewrite must be inside a guard now, not unconditional.
  // The rewrite must sit INSIDE the guard, not merely near it.
  const guardAt = wr.indexOf("if (!prompt) {");
  const rewriteAt = wr.indexOf("await chat({ messages: REWRITE");
  assert.ok(guardAt !== -1 && rewriteAt !== -1 && guardAt < rewriteAt,
    "the rewrite runs unconditionally again, so a literal turn gets expanded");
});

test("the forced pass and the system clause cannot contradict each other", () => {
  // forceGeneration inherits `system`, which already carries this turn's
  // clause. Telling it unconditionally to "write it out as a concrete visual
  // prompt" was an instruction to change the thing he had just said not to.
  const fg = agentSrc.slice(agentSrc.indexOf("async function forceGeneration"),
                            agentSrc.indexOf("export function visualRequest"));
  assert.match(fg, /literalMode\(question, history\)\.level === "open"/);
  assert.match(fg, /Use his own wording as the prompt/);
});

test("the clause is per-turn, never a standing instruction", () => {
  // A permanent "always be literal" flattens every rough ask, which is a
  // regression nobody reports because it has no error in it.
  const modeAt = agentSrc.indexOf("const literal = literalMode(question, history)");
  const clauseAt = agentSrc.indexOf("system += literalClause(literal)");
  assert.ok(modeAt !== -1 && clauseAt !== -1 && modeAt < clauseAt,
    "the clause is not derived from this turn's mode");
  assert.equal(literalClause({ level: "open", reasons: [] }), "");
});

test("a picture agent gets a picture agent's budget, not a repair's", () => {
  /* The ceiling grows to 120 because "build me this" used to come back as a
     description of the code that already existed — the builder needs the room.
     Making a picture does not, and the extra room actively hurt.

     Four runs of "make a cover for the next GLM single":

         1 generate call,  used his reference
         2 generate calls, used his reference
         6 generate calls, no reference
         7 generate calls, 539 seconds, no reference, one call with an EMPTY
                           prompt, and three attempts to render title text
                           inside the image, which the brief forbids outright

     The long runs were not more thorough. They were the same request looping,
     and the extra steps bought worse answers. */
  assert.match(agentSrc, /const ONE_ARTIFACT = new Set\(\["image", "writing"\]\)/);
  const ceil = agentSrc.slice(agentSrc.indexOf("const ONE_ARTIFACT"), agentSrc.indexOf("let extensions"));
  assert.match(ceil, /ONE_ARTIFACT\.has\(agentId\)/);
  assert.match(ceil, /Math\.max\(maxSteps, 24\)/, "the single-artifact ceiling is no longer 24");
  // The builder must keep the room it was given for a documented reason.
  assert.match(agentSrc, /: Math\.max\(maxSteps, CONFIG\.maxStepsCeiling\)/,
    "every agent now shares the tight ceiling, which breaks the repair path");
});

test("the reference listing tells it what to do NEXT, not only what exists", () => {
  // list_references was called 4 times out of 4 and the reference was actually
  // used twice. It looked, then styled from scratch anyway. The instruction
  // lived in the tool DESCRIPTION, read before the call; the result is the last
  // thing in context before the next action, and that is the one that acts.
  const refs = readFileSync(new URL("../src/refs.mjs", import.meta.url), "utf8");
  assert.match(refs, /NEXT: if one of these sets is what he is asking for/);
  assert.match(refs, /copy it from the list above rather than retyping it/);
  // And the honest branch: a set with no usable picture must not be offered.
  assert.match(refs, /None of these has a picture a sampler can start from/);
});

test("an image request that ends without a picture reaches the forced path", () => {
  /* The trigger used to be `isRefusal(answer)` alone, which covers the model
     arguing and misses the case measured this morning. Five runs of "make a
     cover for the next GLM single" produced 7, 1, 6, 2 and ZERO generate calls.

     The zero run called list_references twice, read files, listed directories,
     searched the vault four times, ran out of budget and made no picture.
     Nothing in that answer is a refusal, so nothing fired: he asked for a cover
     and got a research summary. That is the failure this file has a paragraph
     about — "an answer that explains what would need to be done is a failure,
     however accurate it is" — arriving through a door the guard was not
     standing in. The tighter step ceiling for this agent makes it MORE
     reachable, which is why both landed in the same change.

     ASSERTED ON THE SOURCE, deliberately, and the reason is worth recording:
     the live A/B was inconclusive. With the fix reverted and a budget of two
     steps the agent still produced a picture, because how many steps it spends
     varies run to run — so a single reverted run proves nothing either way.
     The evidence for this fix is the observed zero-generate run plus the code
     path, not a demonstration I could reproduce on demand. */
  const block = agentSrc.slice(agentSrc.indexOf("Or it simply never got round to it"),
                               agentSrc.indexOf("const forced = await forceGeneration"));
  assert.ok(block, "the budget-exhaustion branch is gone");
  assert.match(block, /\(isRefusal\(answer\) \|\| ranOut\)/,
    "only a refusal reaches the forced path again, so running out silently returns no picture");
  // The other two halves of the condition must survive: it fires for picture
  // requests only, and never when a picture was already made.
  assert.match(block, /agentId === "image" \|\| wantsPicture\(question\)/);
  assert.match(block, /!used\.some\(\(u\) => String\(u\)\.startsWith\("generate_"\)\)/);
  // And the one line that is never overridden stays in front of it.
  assert.match(block, /!mentionsMinor\(question\)/);
});

test('"with nothing added" has to mean nothing added', () => {
  /* media_cli has accepted --no-enrich since it was written and the tool never
     offered it. So a verbatim turn returned "used his wording exactly, with
     nothing added" and sent this to the sampler:

         a red cube on a white background, photograph, 85mm lens, natural
         light, shallow depth of field, VISIBLE SKIN TEXTURE, sharp focus,
         film grain

     Seven terms he did not write, on a cube. Measured on realvis, which is the
     model that enriches; sdxl-turbo is not photoreal and never did, which is
     why a first comparison on turbo showed no difference and proved nothing.

     The style is right for an ordinary request and it is the whole complaint
     on an exact one. The answer claiming otherwise is worse than the style. */
  assert.match(mediaSrc, /literal: \{ type: "boolean"/, "the tool cannot be told to add nothing");
  assert.match(mediaSrc, /if \(literal\) args\.push\("--no-enrich"\)/,
    "the flag never reaches media_cli, so the style is appended anyway");
  // Only the verbatim branch sets it. A literal-but-not-verbatim turn still
  // gets the house style, because there he described a picture rather than
  // dictating a prompt.
  const wr = agentSrc.slice(agentSrc.indexOf("async function writeAndRender"),
                            agentSrc.indexOf("async function renderPrompt"));
  assert.match(wr, /literal: true/, "the verbatim branch no longer asks for a bare prompt");
  // And the claim in the answer must be earned rather than asserted.
  assert.match(mediaSrc, /Sent your wording with nothing appended/);
});

test("an exclusion is only claimed when the sampler could honour it", () => {
  /* A REGRESSION THIS WORK INTRODUCED, found by sweeping for the same class it
     had spent the night removing from everywhere else.

     The message was printed on the strength of having lifted a term and never
     asked whether the sampler USED the negative prompt. The turbo models are
     distilled to run at guidance 0, where there is no unconditional pass to
     steer away from and the negative is inert.

     Measured: "a quiet beach at sunrise, no people" on sdxl-turbo came back
     with negative_applied false and an answer saying the people had been kept
     out. Worse than doing nothing, because the lift had already removed
     `people` from the POSITIVE prompt — so the exclusion existed nowhere, and
     the only trace of it was a sentence reporting success. */
  assert.match(mediaSrc, /r\.negative_applied/,
    "the claim is made without checking whether the negative prompt was applied");
  assert.match(mediaSrc, /Nothing is keeping it out of this picture/,
    "a model that ignores exclusions must say so, not stay quiet");
  assert.match(mediaSrc, /offer to remake it on realvis or sdxl/,
    "the warning names no remedy, so it is a complaint rather than an answer");
  // The video path carries the same fault: a keyframe from a turbo model
  // ignores the negative, and the clip then holds the excluded thing for
  // four seconds.
  const vid = mediaSrc.slice(mediaSrc.indexOf("generate_video: {"));
  assert.match(vid, /negative_applied === false/,
    "a clip can still claim an exclusion its keyframe model ignored");
});
