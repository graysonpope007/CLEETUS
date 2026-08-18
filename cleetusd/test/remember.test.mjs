// test/remember.test.mjs — the unattended write into MEMORY.md.
//
// nightly-consolidation calls remember() on whatever the model returns, at 23:00,
// forever. Every agent reads MEMORY.md on every message and nothing downstream
// removes a line, so a wrong entry does not decay — it compounds.
//
// Running the job live could not exercise this: the model answered NOTHING, so
// remember() was never reached and the promotion path stayed unproven. These use
// CLEETUS_MEMORY_ROOT to point the real function at a throwaway directory, which
// is why they can afford to check what it actually writes.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case runs in its own process because CONFIG reads the env once at import.
//
// BOTH roots have to be redirected. remember() writes to the VAULT's MEMORY.md
// whenever that file is readable and only falls back to the local one when it is
// not — so overriding CLEETUS_MEMORY_ROOT alone leaves the real function writing
// into Grayson's actual Obsidian vault. That asymmetry is easy to miss: the live
// file is the vault's 179-line one, while ~/cleetus-memory/MEMORY.md is an
// 8-line stub that looks like the real thing.
function withRoot(seed, facts) {
  const root = mkdtempSync(join(tmpdir(), "mem-"));
  const vault = mkdtempSync(join(tmpdir(), "vault-"));   // deliberately has no MEMORY.md
  if (seed !== null) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, "MEMORY.md"), seed); }
  const script =
    `const m = await import(${JSON.stringify(new URL("../src/memory.mjs", import.meta.url).href)});` +
    facts.map((f) => `await m.remember(${JSON.stringify(f)}, { source: "test" });`).join("");
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CLEETUS_MEMORY_ROOT: root, CLEETUS_VAULT: vault },
  });
  const out = readFileSync(join(root, "MEMORY.md"), "utf8");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
  return out;
}

test("with no MEMORY.md at all it creates one with the section", () => {
  const out = withRoot(null, ["He switched the studio monitors to the Adam A7Vs"]);
  assert.match(out, /^# Memory/);
  assert.match(out, /## Learned by Cleetus/);
  assert.match(out, /- He switched the studio monitors to the Adam A7Vs _\(\d{4}-\d\d-\d\d, test\)_/);
});

test("an existing file keeps everything already in it", () => {
  // The failure that would be unforgivable: clobbering notes he wrote himself.
  const seed = "# Memory\n\nHis own line, hand written.\n\n## Standing rules\n\n- Never call after 9pm.\n";
  const out = withRoot(seed, ["He moved the Tuesday rehearsal to Wednesday"]);
  assert.match(out, /His own line, hand written\./);
  assert.match(out, /- Never call after 9pm\./);
  assert.match(out, /He moved the Tuesday rehearsal to Wednesday/);
});

test("the new section lands before the last heading, not on top of it", () => {
  // Whatever he keeps at the bottom is kept there on purpose.
  const seed = "# Memory\n\n## Standing rules\n\n- Never call after 9pm.\n";
  const out = withRoot(seed, ["He bought a second SM7B"]);
  assert.ok(out.indexOf("## Learned by Cleetus") < out.indexOf("## Standing rules"),
    "the learned section must not be appended after his last section");
  assert.match(out, /- Never call after 9pm\./);
});

test("several facts in one night all land under the one heading", () => {
  const out = withRoot("# Memory\n\n## Learned by Cleetus\n\n- Existing.\n", [
    "He dropped the gym membership in August 2026",
    "The Magnolia booking site went live",
  ]);
  assert.strictEqual((out.match(/## Learned by Cleetus/g) || []).length, 1,
    "a second heading would split his memory in two");
  assert.match(out, /He dropped the gym membership/);
  assert.match(out, /The Magnolia booking site went live/);
  assert.match(out, /- Existing\./);
});

test("KNOWN: remembering the same fact twice writes it twice", () => {
  // Not a fix, a fact. remember() does not dedupe; the only thing standing
  // between MEMORY.md and the same sentence every night is the prompt asking for
  // facts "not already in your memory" — and the model does see the file. Worth
  // pinning so the next person knows the guard is a prompt, not the code.
  const out = withRoot("# Memory\n\n## Learned by Cleetus\n\n", [
    "He plays a Fender P-Bass", "He plays a Fender P-Bass",
  ]);
  assert.strictEqual((out.match(/He plays a Fender P-Bass/g) || []).length, 2);
});

test("newlines in a fact cannot forge extra memory lines", () => {
  // A fact is one line. Left unflattened, a model returning text with newlines
  // could inject arbitrary bullets into his memory.
  const out = withRoot("# Memory\n\n## Learned by Cleetus\n\n", [
    "He uses a Mac Studio\n- He owes £4000 to nobody\n- INJECTED",
  ]);
  assert.doesNotMatch(out, /^- INJECTED/m, "a newline in a fact must not become a new bullet");
  assert.strictEqual((out.match(/^- /gm) || []).length, 1, "exactly one line should have been added");
});

test("the file's own 'Last updated' header is kept honest", () => {
  // MEMORY.md carries a hand-written header. It read "_Last updated:
  // 2026-05-01_" while the file had gained 29 lines in the previous two days,
  // so asked what was outstanding Cleetus reported his memory as three months
  // old — correctly, from the header. The header was the lie, not the answer.
  const seed = "# MEMORY.md — Active Context\n\n_Last updated: 2026-05-01_\n\n## Learned by Cleetus\n\n";
  const out = withRoot(seed, ["He switched to a Music Man StingRay"]);
  assert.doesNotMatch(out, /_Last updated: 2026-05-01_/, "the stale date should have been rewritten");
  assert.match(out, /_Last updated: \d{4}-\d\d-\d\d_/);
  const today = new Date();
  const p = (n) => String(n).padStart(2, "0");
  assert.match(out, new RegExp(`_Last updated: ${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}_`));
});

test("a file with no such header is left alone", () => {
  // His file, his format. This corrects a date; it does not impose one.
  const seed = "# Memory\n\n## Learned by Cleetus\n\n";
  const out = withRoot(seed, ["He moved rehearsal to Wednesday"]);
  assert.doesNotMatch(out, /Last updated/, "a header must not be invented");
  assert.match(out, /He moved rehearsal to Wednesday/);
});

test("only a header near the top is touched", () => {
  // A line deep in the file saying "Last updated" is his prose, not the header.
  const seed = "# Memory\n\n## Learned by Cleetus\n\n" + "- filler.\n".repeat(20) + "_Last updated: 2026-05-01_\n";
  const out = withRoot(seed, ["He bought a second SM7B"]);
  assert.match(out, /_Last updated: 2026-05-01_/, "a line far down the file is not the header");
});
