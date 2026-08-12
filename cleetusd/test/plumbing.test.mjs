// test/plumbing.test.mjs — everything except the agent loop's shell.
// Runs against a throwaway vault so it never writes into Obsidian.
//
//   CLEETUS_VAULT=/tmp/cleetusd-test node test/plumbing.test.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLEETUS_VAULT ||= mkdtempSync(join(tmpdir(), "cleetusd-vault-"));
// Memory moved out of the vault (config.mjs explains why), so isolating the
// vault alone is no longer isolation — without this the suite writes runs and
// skills into the REAL ~/cleetus-memory and its counts drift with live data.
process.env.CLEETUS_MEMORY_ROOT ||= mkdtempSync(join(tmpdir(), "cleetusd-memory-"));

const { CONFIG } = await import("../src/config.mjs");
const { AGENTS, agentList, agentMenu, isAgent } = await import("../src/agents.mjs");
const { TOOLS, toolSchemas, callTool } = await import("../src/tools/index.mjs");
const memory = await import("../src/memory.mjs");
const { health } = await import("../src/ollama.mjs");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

console.log(`\nvault:  ${CONFIG.vault}\nmemory: ${CONFIG.memoryRoot}\nmodel:  ${CONFIG.model}\n`);

console.log("config");
check("env file found", Object.keys(CONFIG).length > 0);
check("model resolved", /laguna/.test(CONFIG.model), CONFIG.model);
check("site password loaded for the cloud bridge", CONFIG.sitePassword.length > 0);

console.log("\nagents");
check("registry has the new specialists",
  ["hair", "skin", "muscle", "nutrition", "fashion", "deals", "redesign", "builder"].every(isAgent));
check("every agent has a brief", Object.values(AGENTS).every((a) => a.brief && a.label));
check("body agents are entitled to health", ["hair", "skin", "muscle"].every((id) => AGENTS[id].needs.includes("health")));
check("menu excludes the generalist", !agentMenu().includes("\n- cleetus:"));
console.log(`       ${agentList().length} agents registered`);

console.log("\ntools");
const schemas = toolSchemas();
check("schemas are Ollama-shaped", schemas.every((s) => s.type === "function" && s.function.name && s.function.parameters));
check("filesystem + shell + vault + bridges present",
  // `browse` is deliberately absent: it posted to /api/run, an endpoint the
  // harness has never had. The web_* primitives replaced it and are driven by
  // the tool loop that already exists here. See test/web.test.mjs.
  ["read_file", "write_file", "edit_file", "list_dir", "search_files", "run_shell", "vault_search", "remember_fact", "save_skill", "cloud_api", "web_open", "web_act", "desk_light"]
    .every((n) => n in TOOLS));
console.log(`       ${schemas.length} tools`);

const readBack = await callTool("read_file", { path: "~/cleetusd/package.json" });
check("read_file reads through ~", readBack.includes("cleetusd"), readBack.slice(0, 80));
const missing = await callTool("read_file", { path: "/nope/nothing.txt" });
check("missing file explains itself", missing.startsWith("No such file"));
const listed = await callTool("list_dir", { path: "~/cleetusd/src" });
check("list_dir finds the modules", listed.includes("agent.mjs") && listed.includes("tools/"));
const found = await callTool("search_files", { query: "procedural memory", path: "~/cleetusd", glob: "*.mjs" });
check("search_files greps content", found.includes("memory.mjs"), found.slice(0, 120));

console.log("\nmemory");
const run = await memory.startRun({ agent: "skin", request: "test run please ignore" });
await memory.logStep(run, { tool: "read_file", args: { path: "/x" }, result: "hello" });
await memory.finishRun(run, { answer: "done" });
const runText = await (await import("node:fs/promises")).readFile(run.path, "utf8");
check("run file is markdown with frontmatter", runText.startsWith("---\nagent: skin"));
check("run file records the step", runText.includes("`read_file`"));
check("run file closes out", runText.includes("status: done") && runText.includes("## Answer"));

await memory.saveSkill({ title: "Close the books for a month", when: "he asks to close out a month", steps: ["Pull the ledger", "Group by business", "Reconcile against Plaid"] });
const skills = await memory.loadSkills();
check("skill saved as markdown", skills.length === 1 && skills[0].title === "Close the books for a month");
const rel = await memory.relevantSkills("can you close the books for July");
check("skill retrieved by keyword", rel.length === 1, JSON.stringify(rel.map((r) => r.title)));
const irrel = await memory.relevantSkills("what colour should I paint the shed");
check("irrelevant skill not injected", irrel.length === 0);

// Regression: the scorer once counted any shared 4+ letter word, so a skill
// whose "use when" line read like a sentence matched almost everything through
// stopwords alone. Teacher-written skills are all written that way.
await memory.saveSkill({
  title: "Report training volume",
  when: "User asks what they are lifting today, what volume they have done this week, or any question about recent sets",
  steps: ["Call /api/fitness/workout", "Call /api/fitness/history"],
});
for (const [q, want] of [["what am I lifting today", true], ["how much volume this week", true],
                         ["what should I have for dinner", false], ["what time is it", false]]) {
  const hit = (await memory.relevantSkills(q)).length > 0;
  check(`stopwords do not match: "${q}" -> ${want ? "match" : "no match"}`, hit === want);
}

await memory.remember("Grayson trains five days a week, push pull legs.");
check("fact lands in MEMORY.md", (await memory.loadMemory()).includes("push pull legs"));

console.log("\nmodel");
const h = await health();
check("ollama reachable with the model pulled", h.ok, h.detail);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
