// test/statedfact.test.mjs — what gets written into an agent's memory forever.
//
// Every line these files hold is read back into that specialist's prompt on
// EVERY message. So the cost of the two mistakes is wildly asymmetric: a fact
// missed is one he can say again, a question stored is permanent noise that
// makes the agent worse the more he uses it.
//
// The trigger used to include a bare `my`, which is a possessive, not a
// disclosure. Seven of the eight lines across six agents were his own requests:
// "turn my desk light off", "can you see my Desktop?", "what's on my desk right
// now?". These are those exact lines.

import { test } from "node:test";
import assert from "node:assert";
import { statedFact } from "../src/agent.mjs";
import { readFileSync } from "node:fs";

test("the real junk it accumulated is rejected", () => {
  for (const q of [
    "turn my desk light off",
    "can you see my Desktop?",
    "what's on my desk right now?",
    "what should I set aside for my next quarterly tax payment?",
    "can you read my imessages off this mac right now?",
    "Look at my desk camera and tell me what is on the desk right now.",
  ]) assert.strictEqual(statedFact(q), false, q);
});

test("a question is not a disclosure, with or without the mark", () => {
  // He drops the question mark constantly. The opening word has to carry it.
  for (const q of [
    "can you see my Desktop",
    "should I move my deadlift to Thursday",
    "what is my next show",
    "did I already log my lunch",
  ]) assert.strictEqual(statedFact(q), false, q);
});

test("things he states about himself are still kept", () => {
  // The whole point of the backstop. Losing these is the failure it exists to
  // prevent, so the tightening must not have quietly turned it off.
  for (const q of [
    "I am allergic to shellfish",
    "I'm switching to a 5-day split",
    "I decided to drop the gym membership",
    "I have a show Friday night",
    "I train five mornings a week",
    "remember that Finley's birthday is March 3",
    "my barber is Dave at Fifth Street",
    "my knee has been sore since Tuesday",
  ]) assert.strictEqual(statedFact(q), true, q);
});

test("a curly apostrophe is still an apostrophe", () => {
  // Phones produce these. A rule that only matches the straight one silently
  // stops working for everything typed on the phone, which is most of it.
  assert.strictEqual(statedFact("I’m switching to a 5-day split"), true);
  assert.strictEqual(statedFact("I’ve stopped taking creatine"), true);
});

test("the my-copula cannot reach across a sentence to find a verb", () => {
  // An earlier version allowed 40 characters between "my" and the verb, so
  // "Look at my desk camera and tell me what is on the desk" matched on the
  // "is" belonging to a completely different clause.
  assert.strictEqual(statedFact("Look at my desk camera and tell me what is on the desk"), false);
  assert.strictEqual(statedFact("open my email and see what the venue is asking"), false);
  // ...while a short, genuine claim still matches.
  assert.strictEqual(statedFact("my left shoulder is clicking again"), true);
});

test("nothing absurd gets stored", () => {
  assert.strictEqual(statedFact(""), false);
  assert.strictEqual(statedFact(null), false);
  assert.strictEqual(statedFact(undefined), false);
  // A 400-character wall is a conversation, not a fact worth pinning forever.
  assert.strictEqual(statedFact("I am " + "x".repeat(500)), false);
});

test("a request is never a fact, whatever first-person verb it opens with", () => {
  /* THE MEASURED FAILURE. `i want` and `i need` were in the accept pattern,
     which is right for "I want to put on ten pounds" and catastrophic for "I
     want a picture of a beach": the request itself gets filed as something
     durable about him and read back into every later message to that agent.

     The image agent's memory file had five lines in it and ALL FIVE were his
     own past requests. Asked "that's the one, but warmer light" about a
     photograph of a bassist, it produced a woman on a tropical beach — the
     beach was in its memory and the bassist was only in the conversation. With
     the file emptied and this fix in, the same request came back as the
     bassist, with the previous image reused as a reference.

     This is the second time this function has learned this lesson. The first
     was a bare `my`, and seven of eight remembered lines turned out to be
     questions. */
  for (const q of [
    "no i need you to make me a real image right here and give it to me now",
    "no you are supposed to make the image and put it in the chat. remember that.",
    "i want a picture of a curvy woman in a bikini",
    "i want a video of the show on friday",
    "i need another draft of the email",
    "i want to see the numbers",
    "i need to know what the venue said",
    "make me a website for the farmers market",
    "show me the flights",
    "i want you to try that again",
  ]) {
    assert.strictEqual(statedFact(q), false, `remembered a request: "${q}"`);
  }
});

test("and the preferences it exists for still get through", () => {
  // The veto is about the SHAPE of a request, not about the words "want" and
  // "need". Losing these would be the worse failure: he would have to say them
  // again, every time, forever.
  for (const q of [
    "i want to put on ten pounds before the tour",
    "i need eight hours or i am useless the next day",
    "i prefer dark roast",
    "i train five days a week",
    "i am allergic to shellfish",
    "i decided to stop drinking",
    "my bass is a Fender P-Bass",
    "remember that finleys birthday is december 20",
  ]) {
    assert.strictEqual(statedFact(q), true, `lost a real fact: "${q}"`);
  }
});

test("an instruction about the thing being made now is not a fact about him", () => {
  /* "I need it square" reads like a preference and is the most perishable
     sentence in a conversation: square is what he wanted for that ONE picture.

     Caught the way these keep being caught — by a benchmark typing it. The
     adherence probe's first case is "a portrait of a bearded man. make it
     SQUARE, exactly square, I need it square", and it landed in image.md
     within a minute of the probe being written, into the same file that had
     been emptied an hour earlier for containing exactly this kind of line. */
  for (const q of [
    "a portrait of a bearded man. make it SQUARE, exactly square, I need it square",
    "i want it warmer",
    "i need this bigger",
    "i would like it in black and white",
    "i want them closer together",
  ]) {
    assert.strictEqual(statedFact(q), false, `remembered an instruction: "${q}"`);
  }
});

test("a benchmark can never write into his memory", async () => {
  /* `probe` means the turn is not Grayson. The flag already existed and the
     comment where it is read says what it is for: "Callers testing the system
     mark themselves, so their traffic is not read back later as something
     Grayson asked for."

     That promise was kept for the run files and broken for agent memory, so
     every benchmark in bin/ could permanently alter the thing it measures.
     Asserted on the source because the alternative is running a real turn and
     checking his real memory file, which is the exact hazard being fixed. */
  const src = readFileSync(new URL("../src/agent.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(!probe && statedFact\(question\) && !used\.includes\("remember_fact"\)\)/,
    "probe traffic can still write into an agent's memory");
});
