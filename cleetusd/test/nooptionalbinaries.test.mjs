// test/nooptionalbinaries.test.mjs — the tools have to work on a bare machine.
//
// search_files and find_files were both written against ripgrep, and ripgrep
// is not installed here. The disguise was good: `rg` resolves in an interactive
// shell because the terminal defines it as a FUNCTION, so it works when a human
// types it and ENOENTs the instant execFile spawns it. Both tools returned
// "search failed" for every query and nothing pointed at the cause.
//
// So the test does not ask "is ripgrep here" — it asks the question that
// actually matters: with only the base system on PATH, do these two still
// answer? /usr/bin:/bin has grep and find and can never have Homebrew's rg,
// which means this keeps failing correctly even after someone installs it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs a tool in a child process whose PATH holds only the base system. */
async function onABareMachine(tool, args) {
  const script = `
    const { TOOLS } = await import(${JSON.stringify(join(ROOT, "src/tools/index.mjs"))});
    process.stdout.write(String(await TOOLS[${JSON.stringify(tool)}].run(${JSON.stringify(args)})));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    timeout: 60_000,
    maxBuffer: 4_000_000,
  });
  return stdout;
}

test("ripgrep really is missing, so the fallback is the live path and not decoration", async () => {
  await assert.rejects(
    () => run("rg", ["--version"]),
    (e) => e.code === "ENOENT",
    "rg spawned successfully — if it is genuinely installed now, this test file's premise changed, but the PATH-restricted tests below still hold",
  );
});

test("search_files finds contents with no ripgrep on PATH", async () => {
  const out = await onABareMachine("search_files", {
    query: "onABareMachine",
    path: join(ROOT, "test"),
  });
  assert.match(out, /nooptionalbinaries\.test\.mjs/, `expected a real match, got: ${out.slice(0, 300)}`);
  assert.doesNotMatch(out, /search failed/, "fell through to the failure branch");
});

test("search_files says so plainly when there is nothing to find", async () => {
  // Assembled at runtime on purpose: the first version of this test spelled
  // the needle out as a literal, so the file matched itself and the "no
  // matches" assertion failed against a perfectly correct search.
  const needle = ["zzq", "nothing", "anywhere", "9f31"].join("-nope-");
  const out = await onABareMachine("search_files", { query: needle, path: join(ROOT, "test") });
  assert.match(out, /No matches/, `a miss must read as a miss, not an error: ${out.slice(0, 300)}`);
});

test("find_files finds files by name with no ripgrep on PATH", async () => {
  const out = await onABareMachine("find_files", {
    name: "nooptionalbinaries.test.mjs",
    path: join(ROOT, "test"),
  });
  assert.match(out, /nooptionalbinaries\.test\.mjs/, `expected a real match, got: ${out.slice(0, 300)}`);
  assert.doesNotMatch(out, /find failed/, "fell through to the failure branch");
});

test("find_files says so plainly when nothing is named that", async () => {
  const out = await onABareMachine("find_files", {
    name: "zzq-no-such-file-*.nope",
    path: join(ROOT, "test"),
  });
  assert.match(out, /Nothing named like/, `a miss must read as a miss, not an error: ${out.slice(0, 300)}`);
});

test("every tool that shells out to a non-base binary has a fallback for its absence", async () => {
  // The lesson generalises past these two. If a tool spawns something that is
  // not in the base system, ENOENT has to be handled where it is spawned —
  // otherwise the tool dies the same silent death on a machine without it.
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = join(ROOT, "src/tools");
  const BASE = new Set(["grep", "find", "git", "sh", "bash", "zsh", "/bin/zsh", "/bin/sh", "osascript", "sqlite3", "curl", "defaults", "ioreg", "pgrep", "launchctl", "system_profiler", process.execPath, "node"]);

  const offenders = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".mjs")) continue;
    const src = await readFile(join(dir, f), "utf8");
    for (const m of src.matchAll(/\brun\(\s*"([^"]+)"/g)) {
      const bin = m[1];
      if (BASE.has(bin)) continue;
      // Look at the enclosing tool body for an ENOENT branch.
      const after = src.slice(m.index, m.index + 2500);
      if (!after.includes("ENOENT")) offenders.push(`${f}: spawns "${bin}" with no ENOENT handling`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
