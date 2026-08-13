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
