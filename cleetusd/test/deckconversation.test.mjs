// test/deckconversation.test.mjs — the deck's chat has to outlive the tab.
//
// The conversation store was built, the server has accepted a `conversation`
// field all along, and the deck never sent one. The word did not appear in
// ui.mjs at all. So every chat at 127.0.0.1:8767 lived in a JavaScript variable
// and died with the page, and the entire store was two demo threads with the
// same title.
//
// That is why recall_chat could offer to search "everything Grayson has ever
// said to you" and find nothing he had ever said.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../src/ui.mjs", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

test("the deck sends a conversation id with every message", () => {
  assert.match(ui, /conversation: CONVO/);
  assert.match(ui, /const CONVO = /);
});

test("the id survives a reload", () => {
  // Persisting server-side but rerolling the id each load would write a fresh
  // thread per page view — a store full of one-message conversations, which is
  // its own kind of useless.
  assert.match(ui, /localStorage\.getItem\('cleetus_convo'\)/);
  assert.match(ui, /localStorage\.setItem\('cleetus_convo', id\)/);
});

test("storage being unavailable still persists the thread", () => {
  // Private browsing throws on localStorage. Falling back to no conversation at
  // all would silently restore the original bug for anyone in that mode.
  assert.match(ui, /return 'deck-' \+ Math\.random/);
});

test("the server side was already there", () => {
  // Worth pinning: this was a missing caller, not a missing feature. Nothing on
  // the server needed changing.
  assert.match(server, /if \(body\.conversation\)/);
  assert.match(server, /convos\.open\(body\.conversation/);
});

test("no backticks or template holes in the deck's own comments", () => {
  // ui.mjs is one enormous String.raw template. A backtick in a comment ends it
  // early: adding one broke the whole file, and it was caught by node --check
  // rather than by anything reading the page. The daemon was still serving the
  // previous copy at the time, so nothing user-facing broke — but a restart
  // would have failed to boot.
  const body = ui.slice(ui.indexOf("export const DASHBOARD"));
  const script = body.slice(body.indexOf("<script"), body.indexOf("</script>"));
  const comments = script.split("\n").filter((l) => l.trim().startsWith("//"));
  const bad = comments.filter((l) => l.includes("`") || l.includes("${"));
  assert.deepStrictEqual(bad, [], "these comments would terminate the template literal");
});

// ---------------------------------------------------------------------------
// Conversations are a SECOND store, and it never learned the distinction runs
// had. A probe-marked chat created an UNMARKED thread, so recall_chat — whose
// job is searching everything Grayson has ever said — would surface the
// system's own test threads as his words, forever.
//
// This surfaced from verifying that conversations persist at all: the check
// itself created exactly such a thread.

const convos = readFileSync(new URL("../src/conversations.mjs", import.meta.url), "utf8");

test("a probe chat creates a probe thread", () => {
  assert.match(convos, /export async function open\(id, \{ agent = "cleetus", probe = false \} = \{\}\)/);
  assert.match(convos, /if \(probe\) convo\.probe = true;/);
  // Both HTTP routes must pass it, or the streaming one silently records
  // probes as his.
  // Counted on convos.open specifically. The first version matched
  // "probe: body.probe === true })" and found three, because the ask() call on
  // the same route ends the same way — a test failing on a pattern that was too
  // loose rather than on anything being wrong.
  assert.strictEqual((server.match(/convos\.open\([^)]*probe: body\.probe === true/g) || []).length, 2);
});

test("search and list both exclude probe threads", () => {
  // search() is what recall_chat runs on; list() is what the deck shows. A
  // filter on one and not the other would look fixed from whichever surface
  // happened to be checked.
  assert.match(convos, /export async function search\(query, \{ limit = 5, includeProbes = false \} = \{\}\)/);
  assert.match(convos, /export async function list\(\{ agent = null, limit = 40, includeProbes = false, includeCleared = false \} = \{\}\)/);
  assert.strictEqual((convos.match(/if \(c\.probe && !includeProbes\) continue;/g) || []).length, 2);
});

test("clearing a thread hides it from the rail and from nothing else", () => {
  // Grayson asked for a Clear chat button and, in the same breath, for Cleetus
  // to still remember what was cleared. Those are not opposites: what he wants
  // gone is the transcript in front of him, and what he wants kept is being
  // able to ask about it later. A delete gives him the first by destroying the
  // second, so this is a flag — and the flag has to be honoured in exactly one
  // place. Honoured in search() too and recall_chat would go blind to every
  // conversation he ever tidied away, which is the failure worth testing for.
  assert.match(convos, /export async function clear\(id, cleared = true\)/,
    "clearing must be its own call, not a delete");
  assert.match(convos, /if \(c\.cleared && !includeCleared\) continue;/,
    "list() must skip cleared threads");
  assert.strictEqual((convos.match(/c\.cleared && !includeCleared/g) || []).length, 1,
    "exactly one place may honour `cleared` — search() must NOT, or recall goes blind");
  // The messages are what recall reads. Clearing must not touch them.
  assert.doesNotMatch(convos, /cleared[\s\S]{0,120}messages = \[\]/,
    "clearing must never empty the thread");
});

test("probes can still be read back deliberately", () => {
  // Excluding them by default is right; making them unreachable would mean a
  // test thread could never be inspected after the fact.
  assert.match(convos, /includeProbes = false/);
  assert.doesNotMatch(convos, /if \(c\.probe\) continue;/,
    "an unconditional skip leaves no way to look at them");
});
