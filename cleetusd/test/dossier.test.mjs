// test/dossier.test.mjs — a template must not count as a filled dossier.
//
// The bug this pins down: `if (text)` treated any non-empty file as written,
// so a template of forty blank prompts read as a complete document. The agent
// then had a wall of empty colons in its prompt and no instruction to go and
// ask, which is the worst of both — it knows nothing and does not know to say
// so. Detection is the `status: unfilled` marker in the frontmatter.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vault = mkdtempSync(join(tmpdir(), "dossier-vault-"));
process.env.CLEETUS_VAULT = vault;
process.env.CLEETUS_MEMORY_ROOT = mkdtempSync(join(tmpdir(), "dossier-mem-"));

mkdirSync(join(vault, "40-Areas/Health"), { recursive: true });

const TEMPLATE = `---
dossier: health
status: unfilled
---

# Body

## Hair
- Type:
- Current cut:

## Skin
- Type:
`;
const FILLED = `---
dossier: health
status: current
---

# Body

## Hair
- Type: wavy, medium thickness
`;

// The predicate under test, mirrored from src/agent.mjs and checked against
// the real source at the end so the two cannot silently diverge.
const isUnfilled = (t) => /^status:\s*unfilled\s*$/m.test(t.slice(0, 400));

let pass = 0, fail = 0;
const t = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${d}`)); };

t("a template is unfilled", isUnfilled(TEMPLATE));
t("a written dossier is not", !isUnfilled(FILLED));
t("an empty string is not (handled earlier as missing)", !isUnfilled(""));
t("the marker is only read from the frontmatter, not the body",
  !isUnfilled("---\nstatus: current\n---\n\n" + "x".repeat(500) + "\nstatus: unfilled\n"));
t("a file with no frontmatter is treated as written", !isUnfilled("# Body\n\n- Type: wavy\n"));

// Headings survive so the agent knows what to ask about.
const headings = TEMPLATE.split("\n").filter((l) => /^#{2,3} /.test(l));
t("headings are extracted for the agent to ask from",
  headings.length === 2 && headings[0] === "## Hair", JSON.stringify(headings));
t("blank prompt lines are not passed through",
  !headings.some((h) => h.includes("- Type:")));

const src = await (await import("node:fs/promises")).readFile(
  new URL("../src/agent.mjs", import.meta.url), "utf8");
t("agent.mjs still detects via the frontmatter marker",
  /function isUnfilled\(text\) \{\s*return \/\^status:\\s\*unfilled\\s\*\$\/m\.test\(text\.slice\(0, 400\)\);/.test(src));
t("agent.mjs still offers to fill an unfilled dossier",
  src.includes("askToFill(need)") && src.includes("write_file"));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
