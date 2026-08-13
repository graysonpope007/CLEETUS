// test/memory-and-repos.test.mjs — the three things added for persistence.
//
// Each of these fails SILENTLY in production if it is wrong, which is the only
// reason they are worth a test:
//
//   replay()    trims from the wrong end and the model loses the newest turns
//               while appearing to have full context.
//   keyring     a value that leaks into list() is a secret published to every
//               origin that can read /secrets, with nothing in the UI to show
//               it happened.
//   slugOf()    a remote URL shape that does not parse means a cloned repo is
//               reported as "on GitHub but not cloned here", and Cleetus
//               offers to clone something that is already open on the disk.
//
// Runs against a throwaway memory root, like plumbing.test.mjs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cleetusd-test-"));
process.env.CLEETUS_MEMORY_ROOT = ROOT;

const { create, open, append, replay, list, search, remove } = await import("../src/conversations.mjs");
const keyring = await import("../src/keyring.mjs");
const { slugOf } = await import("../src/repos.mjs");

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log("  ok   " + name))
     : (fail++, console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

console.log("conversations");
{
  const c = await create({ agent: "cleetus" });
  await append(c.id, [{ role: "user", content: "what did we decide about the winchester map" }]);
  await append(c.id, [{ role: "assistant", content: "manual price wins", agent: "cleetus" }]);
  const loaded = await open(c.id);

  // The title is the first thing he said, and it is computed ONCE. A title that
  // drifts as the thread goes on is one he cannot find again in the list.
  t("titled from the first user turn", loaded.title, "what did we decide about the winchester map");
  await append(c.id, [{ role: "user", content: "something else entirely" }]);
  t("title does not drift", (await open(c.id)).title, "what did we decide about the winchester map");

  // Handing a thread to a specialist must not start a new one.
  await append(c.id, [{ role: "assistant", content: "per-home manual overrides", agent: "muscle" }]);
  const rows = await list({});
  const row = rows.find((r) => r.id === c.id);
  t("one thread, both agents recorded", row.agents, ["cleetus", "muscle"]);
  t("turns counts user messages only", row.turns, 2);

  // An unknown id creates rather than 404s, keeping the id the caller holds.
  const adopted = await open("browser-had-a-stale-id");
  t("unknown id is adopted, not rejected", adopted.id, "browser-had-a-stale-id");

  t("search finds it by content", (await search("winchester"))[0].id, c.id);
  t("search misses what is not there", await search("kangaroo"), []);
  await remove(adopted.id);
}

console.log("replay trims from the FRONT");
{
  const c = await create({ agent: "cleetus" });
  // 60 turns against a 40-turn ceiling: the newest 40 must survive.
  for (let i = 0; i < 60; i++) {
    await append(c.id, [{ role: "user", content: `turn ${i}` }]);
  }
  const r = replay(await open(c.id));
  t("capped at the replay ceiling", r.length, 40);
  t("keeps the NEWEST turn", r[r.length - 1].content, "turn 59");
  t("drops the oldest", r[0].content, "turn 20");
}

console.log("replay drops old images but keeps the last");
{
  const c = await create({ agent: "cleetus" });
  const img = { type: "image", source: { data: "AAAA" } };
  await append(c.id, [{ role: "user", content: [{ type: "text", text: "look at this" }, img] }]);
  await append(c.id, [{ role: "assistant", content: "a desk" }]);
  await append(c.id, [{ role: "user", content: [{ type: "text", text: "and this" }, img] }]);
  const r = replay(await open(c.id));
  t("old image becomes a note", r[0].content, "look at this\n[1 image(s) sent earlier in this conversation]");
  t("the newest turn keeps its image", Array.isArray(r[2].content), true);
}

console.log("keyring is one-way");
{
  await keyring.put("openai_api_key", "sk-proj-supersecretvalue", { note: "billing acct" });
  const rows = await keyring.list();

  // THE property. Nothing list() returns may contain the value, because list()
  // is what the HTTP route serves and that route answers over the tunnel.
  const serialised = JSON.stringify(rows);
  t("list() never carries the value", serialised.includes("supersecretvalue"), false);
  t("names are normalised", rows[0].name, "OPENAI_API_KEY");
  t("hint shows the shape, not the key", rows[0].hint, "sk-p…ue (24 chars)");

  const got = await keyring.get("openai_api_key");
  t("in-process get returns it", got.value, "sk-proj-supersecretvalue");
  // The model writes the same key three different ways depending on the
  // sentence. All of them must land on the one secret — this failed on the
  // dashed form, which is the form it uses most.
  t("dashes resolve", (await keyring.get("OPENAI-API-KEY")).value, "sk-proj-supersecretvalue");
  t("spaces resolve", (await keyring.get("openai api key")).value, "sk-proj-supersecretvalue");
  t("dots resolve", (await keyring.get("openai.api.key")).value, "sk-proj-supersecretvalue");
  t("use is counted", (await keyring.list())[0].used, 4);
  t("a missing key is null, not an empty string", await keyring.get("nope"), null);

  t("empty value refused", await keyring.put("X", "").then(() => "accepted", (e) => e.message), "a secret needs a value");
  t("delete works", await keyring.remove("openai_api_key"), true);
  t("delete of a ghost is false", await keyring.remove("openai_api_key"), false);
}

console.log("github remote shapes");
{
  t("https", slugOf("https://github.com/graysonpope007/cleetusv2.git"), "graysonpope007/cleetusv2");
  t("https, no .git", slugOf("https://github.com/graysonpope007/cleetusv2"), "graysonpope007/cleetusv2");
  t("ssh", slugOf("git@github.com:graysonpope007/cleetusv2.git"), "graysonpope007/cleetusv2");
  t("ssh protocol", slugOf("ssh://git@github.com/graysonpope007/cleetusv2.git"), "graysonpope007/cleetusv2");
  // A non-GitHub remote must return "" rather than a wrong slug — a false match
  // here would claim a Codeberg repo is one of his GitHub ones.
  t("not github", slugOf("https://gitlab.com/someone/thing.git"), "");
  t("no remote at all", slugOf(""), "");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
