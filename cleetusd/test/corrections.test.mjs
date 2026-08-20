// test/corrections.test.mjs — learning from the one signal he gives for free.
//
// looksFailed cannot see a wrong picture. Its second line is
// `if (used.length > 0) return false` — a run that called a tool did some work
// — so an image request that produced entirely the wrong thing is recorded as
// a success and the teacher never sees it. The agent whose failures are most
// frequent is the only one that never learns from them.
//
// He tells us anyway. "That is not what I asked for" is a labelled failure, in
// his words, about the turn immediately before.
//
// EVERYTHING HERE IS ABOUT WHAT DOES NOT GET STORED. Before this existed, the
// image agent's memory held five lines and all five were his own past
// requests, read into every image prompt forever — which is why a request
// about a bassist produced a woman on a tropical beach. A memory that fills
// with junk makes the assistant worse the more it is used, so the gate matters
// more than the yield: missing a lesson costs nothing, and storing a bad rule
// costs every future picture.
//
// The distillation itself needs a 33B and is sampled in
// bin/correction-check.mjs. What is tested here is the judgement, which is
// pure, and the wiring, which is not allowed to drift.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import { usableRule, previousAttempt, MAX_RULES } from "../src/corrections.mjs";
import { isCorrection } from "../src/literal.mjs";

const agentSrc = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
const src = readFileSync(new URL("../src/corrections.mjs", import.meta.url), "utf8");

// ── what a rule has to be ─────────────────────────────────────────────────────

test("a usable rule is an instruction that names something a picture has", () => {
  /* Note what is NOT in this list: "Never add clothing, headwear or props he
     did not name". That is the prompt's worked example, and the echo guard
     refuses it unconditionally — so it can never be learned, by design. The
     example was chosen to be a lesson the agent ALREADY HAS for exactly that
     reason, and a test listing it as keepable would be asserting the opposite
     of the design. This test asserted it, and failed. */
  for (const r of [
    "Never add garments or accessories he did not name",
    "When a cover request is made, confirm the aspect before generating",
    "Render single covers square unless he says otherwise",
    "Always pass his reference picture rather than describing it",
    "Never assume dimensions; confirm the aspect ratio before generating images",
  ]) {
    assert.equal(usableRule(r).ok, true, `rejected a good rule: ${r}`);
  }
});

test("a platitude is refused, because it changes no decision and lives forever", () => {
  /* These are not hypothetical. Every one came out of the model during
     development, and each reads perfectly:

       "Always verify all details match the user's exact request"
       "Always verify specific format requirements before generating images"
       "Never assume additional details beyond what is explicitly requested"

     Twenty of those IS a second system prompt nobody wrote, arriving one
     reasonable-looking line at a time. */
  for (const r of [
    "Always verify requests before adding any elements.",
    "Never assume additional details beyond what is explicitly requested.",
    "Always verify all details match the user's exact request before generating.",
    "Always ensure quality and accuracy.",
  ]) {
    const v = usableRule(r);
    assert.equal(v.ok, false, `stored a platitude: ${r}`);
    assert.match(v.why, /names nothing concrete/);
  }
});

test("the correction itself is never stored as the lesson", () => {
  // The exact failure that filled the memory with junk: his words, kept.
  const asked = "make me a picture of a bassist on a dim club stage";
  const correction = "i didnt ask for a hat";
  for (const r of [
    "i didnt ask for a hat",
    "I want a picture of a bassist on a dim club stage",
    "You added a hat he did not ask for",
    "The user did not want a hat in the image",
    "Sure, I will avoid adding hats to images.",
    "Should I avoid adding hats to the image?",
  ]) {
    assert.equal(usableRule(r, { asked, correction }).ok, false, `stored a transcript: ${r}`);
  }
});

test("a rule that merely echoes the prompt's worked example is refused", () => {
  /* Measured on the 8B: shown the hat example it produced the hat rule for a
     correction about IGNORING A REFERENCE PICTURE, and again for a tweak with
     no lesson in it. That is the most convincing kind of wrong — it reads
     perfectly and has nothing to do with what he said.

     The example is deliberately a lesson the agent ALREADY HAS ("add nothing
     he did not name" is in the brief and in literal.mjs's clause), so the one
     thing this guard can wrongly refuse to learn is the one thing that was
     already known. */
  assert.match(src, /const EXAMPLE_RULES = \[/);
  const echo = "Never add clothing, headwear or props he did not name";
  assert.equal(usableRule(echo, { asked: "make a cover", correction: "you ignored my picture" }).ok,
    false, "an echo of the worked example was stored as a lesson");
});

test("length and shape are bounded at both ends", () => {
  assert.equal(usableRule("hats").ok, false);
  assert.equal(usableRule("").ok, false);
  assert.equal(usableRule(null).ok, false);
  assert.equal(usableRule("Never add clothing or props he did not name, ".repeat(8)).ok, false);
});

// ── which turn is being corrected ─────────────────────────────────────────────

test("the corrected turn is the exchange before the correction", () => {
  const h = [
    { role: "user", content: "make me a picture of a bassist" },
    { role: "assistant", content: "Made a 832x1216 image. A bassist in a hat. Saved to /x/img.png" },
    { role: "user", content: "i didnt ask for a hat" },
  ];
  const prev = previousAttempt(h);
  assert.match(prev.asked, /bassist/);
  assert.match(prev.made, /in a hat/);
  // Block content — an attached picture — must not break the read.
  const blocks = [
    { role: "user", content: [{ type: "text", text: "a bassist" }, { type: "image", source: { data: "x" } }] },
    { role: "assistant", content: "Made it, with a hat." },
    { role: "user", content: "i didnt ask for a hat" },
  ];
  assert.equal(previousAttempt(blocks).asked, "a bassist");
});

test("a correction with nothing before it teaches nothing", () => {
  assert.equal(previousAttempt([{ role: "user", content: "i didnt ask for a hat" }]), null);
  assert.equal(previousAttempt([]), null);
});

// ── the wiring, which is where a working idea goes unused ─────────────────────

test("both users of the correction signal share one definition", () => {
  // literalMode uses it to stop treating a correction as a fresh brief;
  // corrections.mjs uses it to decide there is a lesson. Two regexes drifting
  // apart would mean the assistant behaves as if corrected while learning
  // nothing, which is the worse half of both.
  assert.equal(isCorrection("thats not what i asked for"), true);
  assert.equal(isCorrection("make me a cover"), false);
  assert.match(src, /import \{ isCorrection \} from "\.\/literal\.mjs"/);
});

test("a benchmark can never teach the assistant", () => {
  /* `probe` marks traffic that is not Grayson. It was already being ignored
     for run files and NOT for agent memory, which is how the memory filled
     with junk — every benchmark in bin/ could write into it permanently. */
  const fn = src.slice(src.indexOf("export async function captureCorrection"));
  assert.match(fn, /if \(probe\) return null;/);
  assert.ok(fn.indexOf("if (probe) return null;") < fn.indexOf("distilRule"),
    "the probe check runs after the model call, which is a wasted 33B call per benchmark turn");
});

test("learning never delays or breaks his answer", () => {
  // It runs after an answer he is already unhappy with. The same reasoning as
  // teachFromRun: bookkeeping must not turn a slow reply into no reply.
  const call = agentSrc.slice(agentSrc.indexOf("captureCorrection({ agentId"),
                              agentSrc.indexOf("const failed = looksFailed"));
  assert.ok(!/await\s+captureCorrection/.test(agentSrc), "the answer waits for a 33B distillation");
  assert.match(call, /\.catch\(\(\) => \{\}\)/, "a failure to learn can fail the turn");
});

test("the file cannot grow without bound", () => {
  // It is read IN FULL on every message to that agent, so this is live context
  // cost on every request, not archive size.
  assert.ok(MAX_RULES > 0 && MAX_RULES <= 40, `MAX_RULES is ${MAX_RULES}`);
  assert.match(src, /export async function pruneRules/);
  const fn = src.slice(src.indexOf("export async function captureCorrection"));
  assert.match(fn, /pruneRules\(agentId\)/, "nothing prunes, so the prompt grows forever");
});

test("the same lesson is not learned twice", () => {
  const fn = src.slice(src.indexOf("export async function captureCorrection"));
  assert.match(fn, /overlap\(rule, known\) > 0\.8/,
    "a rule he corrects repeatedly would be stored once per correction");
});
