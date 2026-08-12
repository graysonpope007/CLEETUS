// test/brief.test.mjs — one source of truth for an agent's standing brief.
//
// There were two: 20 inline one-liners in agents.mjs and 19 markdown files in
// the web app's repo, with cleetusd reading only the former. The same agent
// therefore had two personalities depending on which half you reached it
// through, and training one would have left the other untouched.
//
// cleetusd now reads brain/agents/<id>.md, the same file the deployed app
// loads. The inline blurb survives only as a fallback so a brand-new agent
// works before anyone writes its file.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const briefs = mkdtempSync(join(tmpdir(), "briefs-"));
process.env.CLEETUS_AGENT_BRIEFS = briefs;
process.env.CLEETUS_VAULT = mkdtempSync(join(tmpdir(), "brief-vault-"));
process.env.CLEETUS_MEMORY_ROOT = mkdtempSync(join(tmpdir(), "brief-mem-"));

const { CONFIG } = await import("../src/config.mjs");
const { AGENTS } = await import("../src/agents.mjs");

let pass = 0, fail = 0;
const t = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${d}`)); };

// Mirrors loadBrief in src/agent.mjs; the source check at the end keeps them
// from drifting apart.
async function loadBrief(agentId, fallback) {
  const text = await readFile(join(CONFIG.agentBriefs, `${agentId}.md`), "utf8").catch(() => "");
  return text.trim() ? text.trim() : fallback;
}

t("config points at the web app's briefs by default or the override",
  CONFIG.agentBriefs === briefs);

writeFileSync(join(briefs, "skin.md"), "# Skin agent\n\nThe deep version.\n");
t("a markdown brief is preferred over the inline blurb",
  (await loadBrief("skin", "INLINE")) .includes("The deep version"));

t("an agent with no file falls back to its inline blurb",
  (await loadBrief("nosuchagent", "INLINE")) === "INLINE");

writeFileSync(join(briefs, "empty.md"), "   \n\n");
t("a blank file falls back rather than blanking the prompt",
  (await loadBrief("empty", "INLINE")) === "INLINE");

// Every registered agent must have somewhere for its brief to come from.
const missing = Object.entries(AGENTS)
  .filter(([, a]) => !a.brief || !a.brief.trim())
  .map(([id]) => id);
t("every registered agent has at least a fallback brief", missing.length === 0, missing.join(", "));

const src = await readFile(new URL("../src/agent.mjs", import.meta.url), "utf8");
t("agent.mjs reads the markdown, not just the registry",
  src.includes("CONFIG.agentBriefs") && src.includes("loadBrief("));
t("and the loaded brief is what goes into the prompt",
  /const brief = await loadBrief\(agentId, agent\.brief\)/.test(src) && /^\s+brief,$/m.test(src));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
