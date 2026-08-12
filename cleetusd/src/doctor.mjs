// src/doctor.mjs — check everything that has silently broken before.
//
// Importable, because a report that only exists when someone remembers to run
// it is not much better than no report. bin/doctor.mjs prints this; the deck
// polls it. Same checks either way — one source of truth about what is broken.
//
// WHY THIS EXISTS
// Every fault in this system so far has been silent. Not one announced itself:
//
//   the deck said LOCAL MODEL while Claude answered every message
//   the flight map showed five clusters and called it the world
//   the lock gesture fired twenty times an hour and nobody was told
//   airpad "stopped working" three times — dead process, no error
//   three orphaned ffmpeg split the camera and it just felt laggy
//   the dashboard said "not running" about a service that was running
//
// The shared shape is that a degraded state looked identical to a good one.
// Each check below is one of those, turned into a question with an answer.
//
// A check that cannot fail is worth nothing, so several assert the NEGATIVE:
// the tunnel must refuse an unauthenticated request, orphan count must be
// zero. Those are the ones that catch a regression rather than confirm a
// happy path.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG, secrets } from "./config.mjs";

const run = promisify(execFile);
const sh = (c) => run("/bin/zsh", ["-lc", c], { timeout: 20_000 }).then(r => r.stdout).catch(e => e.stdout || "");

export async function runDoctor() {
  const results = [];
  const skip = (area, name, detail) => results.push({ area, name, skipped: true, ok: true, detail });

  function check(area, name, ok, detail = "", fix = "") {
  results.push({ area, name, ok, detail, fix });
  }

  async function get(url, ms = 6000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, headers: r.headers, body: await r.text() };
  } catch (e) {
    return { status: 0, error: e.message };
  }
  }

  // ── launchd agents ──────────────────────────────────────────────────────────
  const AGENTS = [
  ["com.cleetus.cleetusd", "the assistant itself"],
  ["com.cleetus.flights", "the ADS-B sweeper"],
  ["com.cleetus.airpad", "the air trackpad"],
  ["com.cleetus.web", "the browser harness"],
  ];
  const uid = (await sh("id -u")).trim();
  for (const [label, what] of AGENTS) {
  const out = await sh(`launchctl print gui/${uid}/${label} 2>/dev/null | head -20`);
  const running = /state = running/.test(out);
  const loaded = out.trim().length > 0;
  check("services", `${label} (${what})`, running,
    loaded ? (running ? "running" : "loaded but not running") : "not loaded",
    loaded ? `launchctl kickstart -k gui/$(id -u)/${label}`
           : `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`);
  }

  // ── every cleetus launch agent points at a file that exists ────────────────
  //
  // This found ten dead services at once, and it is the single worst silent
  // failure in the system so far.
  //
  // The STEAP build ran in a git worktree. The branch was merged and the
  // worktree emptied, but fifteen LaunchAgents still pointed inside it. launchd
  // does exactly what it is told: it respawns, the file is not there, it exits
  // 78 (EX_CONFIG — "configuration error", launchd naming the problem out loud
  // to nobody), and it tries again. com.cleetus.chat did that 18,351 times.
  //
  // Nothing surfaced it. The morning briefing — the 7:03 brief this whole
  // system was built around — had not run since 19 May, and the only visible
  // symptom was a brief that did not arrive.
  //
  // The check is deliberately about the PATH, not about whether the job is
  // running. Most of these are scheduled, so "not running" is their normal
  // state and cannot distinguish healthy from dead. A missing program can.
  const plists = (await sh("ls ~/Library/LaunchAgents/com.cleetus.*.plist 2>/dev/null")).trim().split("\n").filter(Boolean);
  const broken = [];
  for (const plist of plists) {
    const args = await sh(`/usr/libexec/PlistBuddy -c "Print :ProgramArguments" ${JSON.stringify(plist)} 2>/dev/null`);
    for (const line of args.split("\n")) {
      const p = line.trim();
      if (!p.startsWith("/")) continue;
      const exists = (await sh(`test -e ${JSON.stringify(p)} && echo yes`)).trim() === "yes";
      if (!exists) broken.push(`${plist.split("/").pop().replace(/^com\.cleetus\.|\.plist$/g, "")} -> ${p}`);
    }
  }
  check("services", "every launch agent's program exists", broken.length === 0,
    broken.length ? `${broken.length} dead: ${broken.map(b => b.split(" -> ")[0]).join(", ")}` : `${plists.length} agents, all resolve`,
    "the paths point into a removed worktree; rewrite them to ~/.claude/ or bootout the agent");

  // ── local HTTP surfaces ─────────────────────────────────────────────────────
  const PORTS = [
  ["cleetusd", "http://127.0.0.1:8767/health"],
  ["studio-locate", "http://127.0.0.1:8765/api/state"],
  ["airpad", "http://127.0.0.1:8768/api/state"],
  ["cleetus-web", "http://127.0.0.1:8766/api/state"],
  ];
  for (const [name, url] of PORTS) {
  const r = await get(url);
  check("http", `${name} answers`, r.status === 200,
    r.status ? `http ${r.status}` : r.error, `check the launch agent for ${name}`);
  }

  // ── cleetusd internals ──────────────────────────────────────────────────────
  const health = await get("http://127.0.0.1:8767/health");
  if (health.status === 200) {
  const h = JSON.parse(health.body);
  check("cleetusd", "ollama has the model", h.ollama?.ok, h.ollama?.detail,
    "ollama pull " + CONFIG.model);
  check("cleetusd", "vault reachable", h.vault?.reachable, h.vault?.detail,
    "iCloud can block a launchd agent; reads are time-boxed so this degrades");
  check("cleetusd", "shell enabled", h.shell, h.shell ? "on" : "CLEETUSD_NO_SHELL=1");
  }
  // Memory must be writable, or facts are lost with no error anywhere.
  try {
  const probe = join(CONFIG.memoryRoot, ".doctor-probe");
  await writeFile(probe, "x"); await unlink(probe);
  check("cleetusd", "memory root writable", true, CONFIG.memoryRoot);
  } catch (e) {
  check("cleetusd", "memory root writable", false, e.message, `mkdir -p ${CONFIG.memoryRoot}`);
  }
  // Agent briefs: cleetusd and the web app must read the SAME files.
  try {
  const briefs = (await readdir(CONFIG.agentBriefs)).filter(f => f.endsWith(".md") && f !== "_template.md");
  check("cleetusd", "agent briefs present", briefs.length >= 15,
    `${briefs.length} in ${CONFIG.agentBriefs}`);
  } catch (e) {
  check("cleetusd", "agent briefs present", false, e.message);
  }

  // ── cameras: the failure that cost the most time ────────────────────────────
  const ps = await sh("ps -eo pid,ppid,command | grep '[f]fmpeg' | grep avfoundation");
  const cam = ps.split("\n").filter(Boolean);
  const orphans = cam.filter(l => l.trim().split(/\s+/)[1] === "1");
  // An orphaned ffmpeg keeps the camera open after its parent dies. Several
  // accumulate over restarts and split the frames: measured 8.5fps with three
  // orphans against 38fps with none. Nothing reports it; it just feels laggy.
  check("cameras", "no orphaned ffmpeg", orphans.length === 0,
  `${cam.length} capture process(es), ${orphans.length} orphaned`,
  "kill the PPID-1 ffmpeg processes, or restart airpad which reaps them");
  // Two services, two cameras. Sharing one halves both.
  //
  // Captures are addressed by NAME now, because AVFoundation indices shuffle on
  // their own — a Continuity Camera waking is enough — and a service that
  // resolved an index at boot silently ends up on a different physical camera.
  // An index here means an old build is still running.
  const devs = cam.map(l => (l.match(/-i ([^\-]+?)(?:\s+-\w|\s*$)/) || [])[1]).filter(Boolean).map(d => d.trim());
  check("cameras", "one camera each", new Set(devs).size === devs.length,
  devs.length ? `capturing: ${devs.join(" | ")}` : "no capture running",
  "restart both services; each re-resolves its camera by name");
  check("cameras", "addressed by name, not index", !devs.some(d => /^\d+$/.test(d)),
  devs.filter(d => /^\d+$/.test(d)).join(", ") || "all by name",
  "an index binding drifts when AVFoundation reshuffles; restart the service");

  const pad = await get("http://127.0.0.1:8768/api/state");
  if (pad.status === 200) {
  const p = JSON.parse(pad.body);
  // 10fps means the wrong capture mode was negotiated, which is invisible
  // except as a pointer that feels broken.
  check("airpad", "frame rate healthy", p.fps === 0 || p.fps > 20,
    `${p.fps} fps`, "the C920 has ONE mode: 1920x1080@30 through avfoundation");
  check("airpad", "CORS open for the dashboard", !!pad.headers.get("access-control-allow-origin"),
    pad.headers.get("access-control-allow-origin") || "missing",
    "without it the dashboard reports the service dead while it runs");
  }

  // ── the browser tools point at this machine ────────────────────────────────
  // cleetusd read CLEETUS_WEB_URL out of the shared env file, where it is set to
  // https://web.cleetusai.com for the deployed app. That host is NXDOMAIN — it
  // was never added to the tunnel ingress. So every browser call left the
  // machine to reach a service on the same machine, and failed. A same-machine
  // service must be addressed as one.
  check("cleetusd", "browser harness addressed on loopback", /^http:\/\/(127\.0\.0\.1|localhost):/.test(CONFIG.webHarness),
    CONFIG.webHarness,
    "set CLEETUSD_WEB_URL, or leave it unset — do not inherit the cloud app's public hostname");

  // ── the desk light ──────────────────────────────────────────────────────────
  // Unplugged is not a fault — it is a USB device and it travels. What IS a
  // fault is being plugged in and not answering, because the tool would then
  // report "the light is not plugged in" for a light sitting right there.
  const litraUsb = (await sh("ioreg -r -c IOUSBHostDevice -d 1 | grep -c 'Litra'")).trim() !== "0";
  if (litraUsb) {
  const out = await sh(`${CONFIG.home}/studio-locate/.venv/bin/python ${CONFIG.home}/studio-locate/litra_cli.py state`);
  let state = null;
  try { state = JSON.parse(out); } catch { /* left null */ }
  check("devices", "desk light answers", state?.ok === true && state?.on !== null,
    state ? (state.ok ? `on the bus, power ${state.on ? "on" : "off"}` : state.detail) : "no JSON from litra_cli",
    "hidapi must be in studio-locate/.venv; the vendor HID interface is usage page 0xff43");
  } else {
  skip("devices", "desk light", "not plugged in");
  }

  // ── studio-locate gesture, after the calibration ────────────────────────────
  try {
  const cfg = JSON.parse(await readFile(join(CONFIG.home, "studio-locate/config.json"), "utf8"));
  const g = cfg.gestures?.open_to_fist || {};
  // 3.5 fired 20 times in 13 minutes of ordinary typing. Anything above ~1.3
  // overlaps ordinary hand motion, measured over 13,247 frames.
  check("studio-locate", "fist threshold calibrated", g.fist_spread <= 1.3,
    `fist_spread ${g.fist_spread}`,
    "re-run: .venv/bin/python calibrate.py negative 10");
  } catch (e) {
  check("studio-locate", "config readable", false, e.message);
  }

  // ── the cloud, and the security property that matters ───────────────────────
  const me = await get("https://me.cleetusai.com/health", 10_000);
  // THE important one. 200 without a token means an unrestricted shell on this
  // machine is reachable from the internet.
  check("tunnel", "refuses unauthenticated requests", me.status === 401,
  `http ${me.status || me.error}`,
  me.status === 200 ? "STOP. Restore /etc/cloudflared/config.yml.bak.* now." : "");

  const flights = await get("https://cleetusai.com/api/flights?count=1", 15_000);
  if (flights.status === 200) {
  try {
    const f = JSON.parse(flights.body);
    // Swept by the edge means the Mac's snapshot went stale; the map silently
    // drops to about a quarter of the sky.
    check("cloud", "flights swept by the Mac", f.swept_by === "mac-studio",
      `${f.swept_by} · ${f.in_air} aircraft · ${f.anchors_answered}/${f.anchors} anchors`,
      "launchctl kickstart -k gui/$(id -u)/com.cleetus.flights");
  } catch { check("cloud", "flights readable", false, "unparseable"); }
  } else if (flights.status === 401) {
  // Expected without a session cookie. A check that always fails is noise and
  // trains you to ignore the report, which defeats the point of having one.
  skip("cloud", "flights endpoint", "needs a session cookie");
  } else {
  check("cloud", "flights endpoint", false, `http ${flights.status || flights.error}`);
  }

  return { results, failed: results.filter((r) => !r.ok && !r.skipped) };
}
