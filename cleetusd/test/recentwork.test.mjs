// test/recentwork.test.mjs — the source that stops him inventing a day.
//
// Asked "what work have you done today?", Cleetus answered that he had been
// preparing a meeting with Patriot McKee about a GLM booking kickoff at 1000
// Faces Coffee. None of it happened. It is Grayson's own calendar and booking
// history, injected as memory, replayed as a day's work.
//
// The cause was not a bad answer. The question had no answerable source: run
// files are the only record of what he did, and of thirty-five tools not one
// could reach them. Confabulation is what a model does with a question it cannot
// research and has not been told it cannot answer.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real files, own process — CONFIG reads the env once at import.
function withRuns(files, args = {}) {
  const root = mkdtempSync(join(tmpdir(), "work-"));
  const runs = join(root, "runs");
  mkdirSync(runs, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(runs, name), body);
  const script =
    `const m = await import(${JSON.stringify(new URL("../src/tools/work.mjs", import.meta.url).href)});` +
    `process.stdout.write(String(await m.workTools.recent_work.run(${JSON.stringify(args)})));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CLEETUS_MEMORY_ROOT: root, CLEETUS_VAULT: join(root, "novault") },
    encoding: "utf8",
  });
  rmSync(root, { recursive: true, force: true });
  return out;
}

const run = (agent, status, title, extra = "") =>
  `---\nagent: ${agent}\nstatus: ${status}\n${extra}---\n\n# ${title}\n\n- \`read_file\` {}\n`;

test("it reports the work that actually happened", () => {
  const out = withRuns({
    "a.md": run("builder", "done", "fix the flight map"),
    "b.md": run("skin", "failed", "why is my forehead breaking out"),
  });
  assert.match(out, /fix the flight map/);
  assert.match(out, /why is my forehead breaking out/);
  assert.match(out, /\[builder\]/);
  assert.match(out, /failed/);
});

test("probes are excluded — they are not work he asked for", () => {
  // Including them is how the weekly analysis came to tell him he kept asking
  // for a secret he had never once mentioned.
  const out = withRuns({
    "real.md": run("cleetus", "done", "what is on my desk"),
    "probe.md": run("finance", "done", "what is the value of DOCTOR_PROBE_KEY", "probe: true\n"),
  });
  assert.match(out, /what is on my desk/);
  assert.doesNotMatch(out, /DOCTOR_PROBE_KEY/);
});

test("an empty result forbids the guess in words", () => {
  // "No runs" and a broken tool must not read the same, and neither may leave
  // room for filling the gap — that gap is exactly what got filled last time.
  const out = withRuns({});
  assert.match(out, /No runs in the last 24 hours/);
  assert.match(out, /not that the record is missing/);
  assert.match(out, /Do not fill the gap/);
});

test("the window is honest about how far back it looked", () => {
  const out = withRuns({}, { hours: 6 });
  assert.match(out, /last 6 hours/, "the stated window must match the one used");
});

test("the description tells the model it has no other source", () => {
  // A tool the model does not think to call is a tool that does not exist. The
  // description has to say BEFORE, and say plainly that memory is not a source.
  const src = execFileSync("/bin/cat", [new URL("../src/tools/work.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.match(src, /Call this BEFORE answering anything about your own/);
  assert.match(src, /You have NO other record of your own work/);
  assert.match(src, /answering from memory means inventing a day that did/);
});

test("times are shown on his clock, not in UTC", () => {
  const out = withRuns({ "a.md": run("cleetus", "done", "something") });
  const m = out.match(/(\d{4}-\d\d-\d\d \d\d:\d\d)/);
  assert.ok(m, "a timestamp should be rendered");
  const shown = new Date(m[1].replace(" ", "T")).getTime();   // parsed as LOCAL
  assert.ok(Math.abs(Date.now() - shown) < 10 * 60_000,
    `${m[1]} is not within ten minutes of now — this is the UTC-rendering bug again`);
});
