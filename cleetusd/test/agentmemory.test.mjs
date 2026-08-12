// test/agentmemory.test.mjs — who remembers what, and who can see it.
//
// The four properties that have to hold together:
//   1. an agent remembers what he told IT
//   2. every agent sees what he told Cleetus
//   3. Cleetus sees what he told the agents
//   4. one specialist does not read another's detail — that is what makes it
//      specialised, and it is the one that a naive "share everything" design
//      gets wrong.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLEETUS_VAULT = mkdtempSync(join(tmpdir(), "agentmem-vault-"));
process.env.CLEETUS_MEMORY_ROOT = mkdtempSync(join(tmpdir(), "agentmem-root-"));

const m = await import("../src/memory.mjs");
const { callTool } = await import("../src/tools/index.mjs");

let pass = 0, fail = 0;
const t = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${d}`)); };

// He tells the skin agent something specialised.
await m.rememberForAgent("skin", "Benzoyl peroxide over 5% burns his neck after shaving.");
// And the muscle agent something else.
await m.rememberForAgent("muscle", "Overhead press aggravates his left shoulder.");
// And Cleetus something everyone should know.
await m.remember("He is at Warren on Sunday mornings and cannot train then.");

const skin = await m.loadAgentMemory("skin");
const muscle = await m.loadAgentMemory("muscle");
const shared = await m.loadMemory();
const digest = await m.loadAllAgentMemory();

t("1. the skin agent remembers what he told it", skin.includes("Benzoyl peroxide"));
t("2. shared memory holds what he told Cleetus", shared.includes("Warren on Sunday"));
t("3. the generalist sees both specialists in the digest",
  digest.includes("Benzoyl peroxide") && digest.includes("Overhead press"), digest.slice(0, 120));
t("4. the skin agent does NOT see the muscle agent's detail", !skin.includes("Overhead press"));
t("4b. and the muscle agent does not see skin's", !muscle.includes("Benzoyl peroxide"));
t("the digest labels which agent each line came from",
  /\*\*skin\*\*/.test(digest) && /\*\*muscle\*\*/.test(digest));
t("the generalist reads nothing as 'its own'", (await m.loadAgentMemory("cleetus")) === "");

// The tool routes by scope, using the agent in context.
await callTool("remember_fact", { fact: "He shaves with a safety razor.", scope: "mine" }, { agentId: "skin" });
await callTool("remember_fact", { fact: "He drives a Tacoma.", scope: "shared" }, { agentId: "skin" });
const skin2 = await m.loadAgentMemory("skin");
const shared2 = await m.loadMemory();
t("scope 'mine' writes to the calling agent's file", skin2.includes("safety razor"));
t("scope 'mine' does NOT leak into shared", !shared2.includes("safety razor"));
t("scope 'shared' writes to shared", shared2.includes("Tacoma"));
t("scope 'shared' does not also land in the agent file", !skin2.includes("Tacoma"));

// A specialist scope from the generalist has nowhere private to go.
await callTool("remember_fact", { fact: "He prefers mornings.", scope: "mine" }, { agentId: "cleetus" });
t("'mine' from the generalist falls back to shared", (await m.loadMemory()).includes("prefers mornings"));

// Unbounded growth would quietly eat the generalist's prompt.
for (let i = 0; i < 12; i++) await m.rememberForAgent("hair", `fact ${i}`);
const capped = await m.loadAllAgentMemory(4);
const hairLines = capped.split("**hair**")[1].split("\n\n")[0].split("\n").filter((l) => l.startsWith("- "));
t("the digest caps how much of each agent it shows", hairLines.length === 4, String(hairLines.length));
t("and says how much it left out", /12 total, latest 4/.test(capped));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
