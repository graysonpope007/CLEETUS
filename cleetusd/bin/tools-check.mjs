#!/usr/bin/env node
// bin/tools-check.mjs — does every tool cleetusd advertises actually work?
//
//   node bin/tools-check.mjs
//
// Not part of the doctor: it writes files, drives a browser and touches memory,
// so it is run deliberately rather than on a schedule. It cleans up after
// itself: the probe fact and probe skill it writes are removed at the end.
// (They were not, and a "toolsweep probe" skill sat in the skills list looking
// like something Cleetus had learned.)
//
// `browse` was offered to the model on every message and had never worked once.
// That is not a bug you find by reading code — it is found by calling the thing.
// So: call every tool, with arguments a model would plausibly send, and look at
// what comes back.
//
// Read-only or scratch-scoped wherever possible. Writes go to a temp dir.

import { TOOLS, callTool } from "../src/tools/index.mjs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "toolsweep-"));
const probe = join(scratch, "probe.txt");

// [tool, args, verdict(out) -> null if fine, string if broken]
const CASES = [
  ["list_dir", { path: "/Users/grayson/cleetusd/src" }, (o) => /agent\.mjs/.test(o) ? null : "did not list the source"],
  ["read_file", { path: "/Users/grayson/cleetusd/package.json" }, (o) => /cleetusd|name/.test(o) ? null : "did not read"],
  ["write_file", { path: probe, content: "sweep-marker" }, (o) => /error|failed/i.test(o) ? o : null],
  ["read_file", { path: probe }, (o) => /sweep-marker/.test(o) ? null : "wrote but could not read back"],
  ["edit_file", { path: probe, find: "sweep-marker", replace: "edited-marker" }, (o) => /error|failed|no such/i.test(o) ? o : null],
  ["read_file", { path: probe }, (o) => /edited-marker/.test(o) ? null : "edit did not take"],
  ["search_files", { query: "looksFailed", path: "/Users/grayson/cleetusd/src" }, (o) => /agent\.mjs/.test(o) ? null : "grep found nothing it should have"],
  ["find_files", { name: "doctor.mjs", path: "/Users/grayson/cleetusd" }, (o) => /doctor\.mjs/.test(o) ? null : "did not find a file that exists"],
  ["run_shell", { command: "echo sweep-ok" }, (o) => /sweep-ok/.test(o) ? null : "shell did not run"],
  ["check_access", {}, (o) => /access|home|denied|items/i.test(o) ? null : "no access report"],
  ["vault_search", { query: "cleetus" }, (o) => /not readable/.test(o) ? "vault blocked" : (o.trim() ? null : "empty")],
  ["vault_read", { note: "MEMORY.md" }, (o) => /not readable/.test(o) ? "vault blocked" : (o.trim() ? null : "empty")],
  ["desk_light", { action: "state" }, (o) => /light is (on|off)/.test(o) ? null : o],
  ["web_open", { url: "https://www.amazon.com" }, (o) => /amazon/i.test(o) ? null : o.slice(0, 120)],
  ["web_read", {}, (o) => /things you can act on|amazon/i.test(o) ? null : o.slice(0, 120)],
  ["web_act", { action: "scroll" }, (o) => /not running|refused/i.test(o) ? o.slice(0, 120) : null],
  ["web_pending", {}, (o) => /waiting|approval|:/.test(o) ? null : o.slice(0, 120)],
  // Vision, added by the other session. Read-only: they look through a camera
  // and describe or name what is there. Slow (a model call per look), so one
  // sample each rather than a sweep.
  ["known_faces", {}, (o) => /nobody|no one|none|:/i.test(o) ? null : o.slice(0, 90)],
  // "brio" IS NOT A CAMERA NAME. The two are desk and room, and these cases
  // passed for weeks while calling neither: `look` answered "[object Object]"
  // and the verdict matched none of its words, so a tool that could not
  // possibly have worked was reported green three times over. A checker that
  // asks for something that does not exist tests nothing.
  //
  // The verdicts now assert the SHAPE OF A REAL ANSWER — the camera's own
  // description, which only appears when a frame was actually looked at —
  // rather than the absence of words that mean failure.
  ["look", { camera: "desk" }, (o) => /looking (straight )?down at the desk/i.test(o) ? null : o.slice(0, 120)],
  ["look", { camera: "room" }, (o) => /across the room/i.test(o) ? null : o.slice(0, 120)],
  ["look", { camera: "brio" }, (o) => /no camera called/i.test(o) ? null : "a bad camera name did not produce a usable error: " + o.slice(0, 90)],
  ["who_is_there", { camera: "room" }, (o) => /through the room camera|recognise|enrolled/i.test(o) ? null : o.slice(0, 120)],
  // ── added by the other session, classified here ──
  // Read-only: they report state and take no action on the world.
  ["list_repos", {}, (o) => /cleetus|repo|\//i.test(o) ? null : o.slice(0, 90)],
  ["repo_status", { repo: "cleetusv2" }, (o) => /## \w|\/Users\/|clean|uncommitted/i.test(o) ? null : o.slice(0, 90)],
  ["list_secrets", {}, (o) => /secret|key|holding|\[/i.test(o) ? null : o.slice(0, 90)],
  ["recall_chat", { query: "desk light" }, (o) => /cannot|failed|error/i.test(o) ? o.slice(0, 90) : null],
  ["detect", { camera: "desk" }, (o) => /one frame, detector|nothing the detector knows/i.test(o) ? null : o.slice(0, 120)],
  ["watch", { camera: "room", seconds: 3 }, (o) => /frames over .*s at .*fps|Nothing tracked/i.test(o) ? null : o.slice(0, 120)],
  ["cloud_api", { path: "/api/health" }, (o) => {
    if (/^(?!\{).*(not set|unauthorized)/i.test(o)) return o.slice(0, 160);
    try { JSON.parse(o); return null; } catch { return "not JSON: " + o.slice(0, 120); }
  }],
  // Writes into real memory; scoped so it is obviously a probe.
  ["remember_fact", { fact: "TOOLSWEEP PROBE — delete me", scope: "mine" }, (o) => /saved/i.test(o) ? null : o],
  ["save_skill", { title: "toolsweep probe", when: "never", steps: ["delete me"] }, (o) => /saved/i.test(o) ? null : o],
];

const broken = [];
for (const [name, args, verdict] of CASES) {
  if (!TOOLS[name]) { broken.push([name, "NOT REGISTERED"]); continue; }
  let out;
  let raw;
  try { raw = await callTool(name, args, { agentId: "builder" }); out = String(raw); }
  catch (e) { raw = null; out = "THREW: " + e.message; }
  // The whole class, caught once rather than per tool. Anything that is not a
  // string reaches the model as "[object Object]", and the model does not
  // report an empty tool result — it invents a plausible one. This is checked
  // before the verdict runs, because a verdict looking for words cannot see
  // this failure at all.
  if (raw !== null && typeof raw !== "string") {
    broken.push([name, `returned a ${typeof raw}, not a string — the model would receive "[object Object]"`]);
    console.log(`FAIL ${name}\n       returned ${typeof raw}, not a string`);
    continue;
  }
  const bad = out.startsWith("THREW:") ? out : verdict(out);
  const label = `${name}(${Object.keys(args).join(",") || ""})`;
  if (bad) { broken.push([label, bad]); console.log(`FAIL ${label}\n       ${String(bad).replace(/\n/g, " ").slice(0, 200)}`); }
  else console.log(`ok   ${label}`);
}

// Deliberately never exercised, with the reason, so it does not read as an
// oversight. send_email reaches a real person: a probe would land in somebody's
// inbox, and there is no dry-run on the other side.
const WONT_TEST = {
  send_email: "sends real email to a real person",
  // Writes a named face to disk. A probe would either enrol a fictional person
  // into Grayson's recogniser or enrol whoever happens to be at the desk under
  // a test name, and both are worse than leaving one tool unexercised.
  learn_face: "enrols a real person's face into the recogniser",

  // Each of these does something to the world, to Grayson's accounts, or needs
  // an argument only a real conversation supplies. A sweep that exercised them
  // would be doing the damage it is meant to detect.
  save_secret: "writes a real credential into the keyring",
  forget_secret: "deletes a real credential",
  get_secret: "reads a credential value into this process — covered by the leak test instead",
  clone_repo: "clones a repository onto the disk",
  github: "runs the GitHub CLI as Grayson against real issues and pull requests",
  watch: "holds a camera open for several seconds; detect covers the same path in one frame",
  read_chat: "needs a real conversation id, which recall_chat supplies at runtime",
};

const untested = Object.keys(TOOLS).filter((t) => !CASES.some(([n]) => n === t));
const unexplained = untested.filter((t) => !WONT_TEST[t]);
console.log(`\n${CASES.length} calls, ${broken.length} broken.`);
for (const t of untested) console.log(`  not exercised: ${t} — ${WONT_TEST[t] || "NO REASON GIVEN, this is a gap"}`);
if (unexplained.length || broken.length) process.exitCode = 1;

// ── clean up after itself ───────────────────────────────────────────────────
// remember_fact and save_skill are only exercised by actually writing, so the
// probes have to be real. Leaving them is not acceptable: memory is a thing
// Grayson reads, and a fake skill in it is noise that looks like signal.
{
  const home = process.env.HOME;
  const removed = [];
  const skills = join(home, "cleetus-memory", "skills");
  for (const f of await readdir(skills).catch(() => [])) {
    const p = join(skills, f);
    if (/toolsweep/i.test(await readFile(p, "utf8").catch(() => ""))) {
      await rm(p).catch(() => {});
      removed.push(f);
    }
  }
  const agents = join(home, "cleetus-memory", "agents");
  for (const f of await readdir(agents).catch(() => [])) {
    const p = join(agents, f);
    const t = await readFile(p, "utf8").catch(() => "");
    if (!/TOOLSWEEP/.test(t)) continue;
    await writeFile(p, t.split("\n").filter((l) => !/TOOLSWEEP/.test(l)).join("\n"));
    removed.push(f);
  }
  console.log(removed.length ? `cleaned up probes: ${removed.join(", ")}` : "no probes left behind");
}
