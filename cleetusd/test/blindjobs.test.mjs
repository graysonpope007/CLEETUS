// test/blindjobs.test.mjs — "nothing to do" must not be able to mean "I could not look".
//
// The header of src/jobs.mjs states the doctrine plainly:
//
//   "A job that reports 'nothing to do' when it actually could not look would be
//    the same bug in a new costume."
//
// And recentRunFiles() opened with `readdir(RUNS).catch(() => [])`, which is
// that bug exactly. Four jobs read through that helper. Rename the runs
// directory, move it, or take away its permissions, and the nightly
// consolidation reports "nothing durable", the open loops report "Nothing open",
// and the weekly analysis reports a blank week — all of them cheerful, all of
// them blind, and nothing anywhere saying so.
//
// Tested by actually pointing the daemon at a directory that is not there,
// because the whole point is what happens at the filesystem boundary, and a
// stubbed readdir would be testing the stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs one job with the memory root pointed wherever we like. */
async function job(id, memoryRoot) {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(ROOT, "bin/job.mjs"), id], {
      env: { ...process.env, CLEETUS_MEMORY_ROOT: memoryRoot },
      timeout: 120_000,
      maxBuffer: 8_000_000,
    });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}${e.message}` };
  }
}

test("a missing runs directory fails the job instead of reading as an empty day", async () => {
  const gone = join(tmpdir(), "cleetusd-not-here-9f31");
  const r = await job("nightly-consolidation", gone);
  assert.match(r.out, /cannot read the runs directory/,
    `expected a loud failure, got: ${r.out.slice(0, 200)}`);
  assert.doesNotMatch(r.out, /nothing to consolidate/,
    "reporting nothing durable here would be the exact bug this guards");
});

test("the message says which directory and that the day was not simply empty", async () => {
  const gone = join(tmpdir(), "cleetusd-not-here-9f31");
  const r = await job("nightly-consolidation", gone);
  assert.match(r.out, /cleetusd-not-here-9f31/, "name the path, so it is fixable without guessing");
  assert.match(r.out, /blind one/, "the distinction is the whole point and belongs in the message");
});

test("a runs directory that exists and is empty is still a normal quiet day", async () => {
  // The other half of the distinction. An empty directory means there genuinely
  // was nothing, and that must NOT fail — otherwise the guard becomes noise on
  // every quiet day and gets removed.
  const root = await mkdtemp(join(tmpdir(), "cleetusd-empty-"));
  await mkdir(join(root, "runs"), { recursive: true });
  const r = await job("nightly-consolidation", root);
  assert.ok(r.ok, `an empty runs directory must not fail: ${r.out.slice(0, 200)}`);
  assert.match(r.out, /nothing to consolidate/);
});
