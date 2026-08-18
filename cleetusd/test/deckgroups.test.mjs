// test/deckgroups.test.mjs — every agent reaches the deck.
//
// The deck arranges agents by hand in a GROUPS object and renders only the ids
// named there: `for (const id of ids) if (byId[id]) addAgent(...)`. An agent
// added to the registry but not to that object would work perfectly over the
// API and be invisible to the person it was built for, with nothing anywhere
// reporting it.
//
// The grouping stays hand-written — the ordering is editorial and worth keeping.
// What changed is that forgetting to place one is now visible instead of silent.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { agentList } from "../src/agents.mjs";

const ui = readFileSync(new URL("../src/ui.mjs", import.meta.url), "utf8");
const groupBlock = ui.slice(ui.indexOf("const GROUPS = {"), ui.indexOf("};", ui.indexOf("const GROUPS = {")));
const grouped = [...groupBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

test("every registered agent is placed in a group", () => {
  const missing = agentList().map((a) => a.id).filter((id) => id !== "cleetus" && !grouped.includes(id));
  assert.deepStrictEqual(missing, [],
    "these agents exist but are not arranged on the deck — add them to GROUPS in ui.mjs");
});

test("no group names an agent that does not exist", () => {
  const ids = new Set(agentList().map((a) => a.id));
  const ghosts = grouped.filter((g) => !ids.has(g));
  assert.deepStrictEqual(ghosts, [],
    "the deck reserves space for agents that are not registered");
});

test("an unplaced agent still renders, under Ungrouped", () => {
  // The safety net, so a missed entry degrades to "in the wrong place" rather
  // than "gone". A test alone would only catch it if somebody ran the tests.
  assert.match(ui, /const placed = new Set\(Object\.values\(GROUPS\)\.flat\(\)\);/);
  assert.match(ui, /const strays = agents\.filter\(a => a\.id !== 'cleetus' && !placed\.has\(a\.id\)\)/);
  assert.match(ui, /textContent = 'Ungrouped'/);
});

test("the fallback runs after the groups, not instead of them", () => {
  // If it ran first every agent would land in Ungrouped and the editorial
  // arrangement would be dead code that still passes its own test.
  assert.ok(ui.indexOf("for (const [name, ids] of Object.entries(GROUPS))") < ui.indexOf("const strays ="),
    "the arranged groups must render first");
});
