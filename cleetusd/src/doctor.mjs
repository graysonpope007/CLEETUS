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
import { createHmac } from "node:crypto";
import { promisify } from "node:util";
import { readFile, readdir, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG, secrets } from "./config.mjs";
import { accessReport } from "./access.mjs";

const run = promisify(execFile);
const sh = (c) => run("/bin/zsh", ["-lc", c], { timeout: 20_000 }).then(r => r.stdout).catch(e => e.stdout || "");

// The one Python on this machine with OpenCV and hidapi in it. Both the light
// and the face recogniser are studio-locate's dependencies borrowed rather than
// duplicated, so they borrow the same interpreter.
const PY_CV = process.env.CLEETUSD_PYTHON || `${CONFIG.home}/studio-locate/.venv/bin/python`;

/**
 * Launch agents that exist on disk but are not loaded into launchd.
 *
 * On 14 Aug 2026 com.cleetus.ollama was not stopped — it was UNLOADED. That is
 * why nothing recovered it: `KeepAlive` only applies to an agent launchd knows
 * about, so an unloaded agent is not a service that is down, it is a service
 * that no longer exists as far as the system is concerned. The local model was
 * gone for some minutes and the plist, the binary and the log all looked fine.
 *
 * The check above this one is deliberately about the PATH rather than about
 * whether a job is RUNNING, and that reasoning still holds: most of these are
 * scheduled, so "not running" is their healthy state and says nothing. But
 * "not loaded" is different in kind. A loaded agent that is idle will fire at
 * its next interval. An unloaded one never will, and nothing else in this file
 * can tell the difference.
 *
 * Split out and exported so the comparison can be tested without unloading a
 * real service to see what happens.
 */
export function unloadedAgents(plistPaths = [], launchctlList = "") {
  const loaded = new Set(
    String(launchctlList).trim().split("\n").slice(1)
      .map((l) => l.split("\t").pop().trim())
      .filter(Boolean),
  );
  return plistPaths
    .map((p) => String(p).split("/").pop().replace(/\.plist$/, ""))
    .filter((label) => label && !loaded.has(label));
}

export async function runDoctor() {
  const results = [];
  const skip = (area, name, detail) => results.push({ area, name, skipped: true, ok: true, detail });

  function check(area, name, ok, detail = "", fix = "") {
  results.push({ area, name, ok, detail, fix });
  }

  /**
   * One probe of a local service is one sample, and these services do real work
   * — studio-locate is decoding camera frames. Under load it blocks past six
   * seconds and the panel calls it down: twice this session it was reported
   * broken and then answered in 0.19s when asked directly a minute later. A
   * check that cries wolf is a check he stops reading.
   *
   * A TIMEOUT is ambiguous, so it is worth asking twice. A refused connection
   * is not — nothing is listening — so that returns immediately and the doctor
   * stays fast when a service really is down.
   */
  async function get(url, ms = 6000) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
        return { status: r.status, headers: r.headers, body: await r.text() };
      } catch (e) {
        last = e;
        if (!/timeout|abort/i.test(String(e.message))) break;
      }
    }
    return { status: 0, error: last ? last.message : "unknown" };
  }

  // ── launchd agents ──────────────────────────────────────────────────────────
  const AGENTS = [
  ["com.cleetus.cleetusd", "the assistant itself"],
  ["com.cleetus.flights", "the ADS-B sweeper"],
  ["com.cleetus.airpad", "the air trackpad"],
  ["com.cleetus.web", "the browser harness"],
  ["com.cleetus.studio", "studio-locate, the BRIO"],
  ];
  const uid = (await sh("id -u")).trim();
  const DOWN_BECAUSE = new Map();
  for (const [label, what] of AGENTS) {
  const out = await sh(`launchctl print gui/${uid}/${label} 2>/dev/null | head -20`);
  const running = /state = running/.test(out);
  const loaded = out.trim().length > 0;

  // WHY it is not running, from the service's own stderr.
  //
  // "loaded but not running" is a symptom, and the fix beside it — kickstart —
  // is the wrong advice whenever the cause is not transient. The air trackpad
  // went down and the panel said exactly that; the log said
  // "No camera matching 'c920'. Available: [0] Logitech BRIO, ...", which is a
  // webcam being unplugged and no amount of restarting will help.
  //
  // launchd already knows where each service writes its errors, so this reads
  // the plist rather than guessing at a filename.
  let why = "";
  if (loaded && !running) {
    const errPath = (out.match(/stderr path = (\S+)/) || [])[1]
      || (await sh(`/usr/libexec/PlistBuddy -c "Print :StandardErrorPath" ~/Library/LaunchAgents/${label}.plist 2>/dev/null`)).trim();
    if (errPath) {
      const tail = await readFile(errPath.replace(/^~/, CONFIG.home), "utf8").catch(() => "");
      const line = tail.trim().split("\n").reverse()
        .find((l) => /error|exception|no such|not found|refused|denied|no camera|traceback/i.test(l));
      if (line) why = ` — ${line.trim().slice(0, 120)}`;
    }
    // Remembered so the HTTP check for the same service can defer to it. Two
    // checks describe one process; without this the port check kept advising a
    // restart while the service check three lines up already knew the webcam
    // was unplugged.
    if (why) DOWN_BECAUSE.set(label.replace(/^com\.cleetus\./, ""), why.replace(/^ — /, ""));
  }

  check("services", `${label} (${what})`, running,
    loaded ? (running ? "running" : `loaded but not running${why}`) : "not loaded",
    !loaded ? `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`
      // When the log named a cause, restarting is the wrong first move. The air
      // trackpad refused to start on every attempt while the C920 was unplugged,
      // and a fix line reading "kickstart" invites exactly that loop.
      : why ? "fix the cause above first — kickstart only helps if it was transient"
            : `launchctl kickstart -k gui/$(id -u)/${label}`);
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
  // Nothing surfaced it. Among the dead: the nightly consolidation, the vault
  // sync, the memory reindex, and a morning_briefing.py that posts a markdown
  // summary to Slack. NOT the brief Grayson reads — that one is the cloud
  // app's, stored in the DB, and has been healthy throughout. Worth stating,
  // because the first version of this comment said otherwise and sent everyone
  // looking in the wrong place.
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
    // The ten that were dead here for three months are rebuilt: they point at
    // cleetusd/bin/job.mjs now, one binary that cannot go missing without the
    // whole daemon going with it (see src/jobs.mjs). If this goes red again it
    // is a NEW agent, and the same rule applies — a repoint is not a fix unless
    // the thing being pointed at still does the job. The originals computed
    // their vault as Path(__file__).parents[2]/"vault", so repointing them
    // would have moved the vault to a directory that does not exist, and this
    // check would have gone green over a brief written where nobody looks.
    "point it at something that exists AND still works from there; `node ~/cleetusd/bin/job.mjs --list` for the rebuilt ones");

  // ── every launch agent is actually loaded ───────────────────────────────────
  //
  // See unloadedAgents(): com.cleetus.ollama was unloaded rather than stopped,
  // so KeepAlive had nothing to keep alive and the local model simply went away.
  // The plist was on disk, the binary was on disk, and the log ended on "all
  // slots are idle". Every check in this file passed while it was gone.
  //
  // The recovery is in the fix text on purpose, because the instinct on seeing a
  // dead service is `kickstart` — and kickstart on an agent launchd has never
  // heard of does nothing at all.
  {
    const listing = await sh("launchctl list 2>/dev/null");
    const missing = unloadedAgents(plists, listing);
    check("services", "every launch agent is loaded into launchd", missing.length === 0,
      missing.length
        ? `${missing.length} on disk but not loaded: ${missing.join(", ")} — launchd will never start ${missing.length === 1 ? "it" : "them"}`
        : `all ${plists.length} agents loaded`,
      "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist — kickstart does nothing for an agent that is not loaded");
  }

  // ── every plist is valid XML ────────────────────────────────────────────────
  //
  // launchd's parser is lenient and accepts things XML does not. A double
  // hyphen inside a comment is illegal, and writing a command line into the
  // documentation at the top of a plist puts one there — which is how
  // com.cleetus.flights and com.cleetus.improve became unparseable, and how
  // com.cleetus.studio joined them within minutes of being written, by someone
  // who had already documented the trap.
  //
  // It works, so nothing complains. It breaks the moment any strict parser
  // reads it: PlistBuddy is fine, Python's plistlib throws, and a script that
  // walks these files silently skips the ones it cannot read.
  const badXml = [];
  for (const plist of plists) {
    const ok = await sh(`/usr/bin/python3 -c "import plistlib,sys; plistlib.load(open(sys.argv[1],'rb'))" ${JSON.stringify(plist)} 2>&1 | head -1`);
    if (ok.trim()) badXml.push(plist.split("/").pop().replace(/^com\.cleetus\.|\.plist$/g, ""));
  }
  check("services", "every plist is valid XML", badXml.length === 0,
    badXml.length ? `${badXml.length} unparseable: ${badXml.join(", ")}` : `${plists.length} plists parse`,
    "almost always a double hyphen inside an XML comment — rephrase, do not quote a command line");

  // ── local HTTP surfaces ─────────────────────────────────────────────────────
  const PORTS = [
  ["cleetusd", "http://127.0.0.1:8767/health"],
  ["studio-locate", "http://127.0.0.1:8765/api/state"],
  ["airpad", "http://127.0.0.1:8768/api/state"],
  ["cleetus-web", "http://127.0.0.1:8766/api/state"],
  ];
  // studio-locate is the odd one out: it has no launch agent, so "check the
  // launch agent for studio-locate" sends you looking for a file that does not
  // exist. It is started by hand, which is also why it is the one that is down.
  // studio-locate has an agent now (com.cleetus.studio). It was the only
  // service without one, which is precisely why it was the one that kept being
  // down: nothing restarted it.
  const NO_AGENT = {};
  for (const [name, url] of PORTS) {
  const r = await get(url);
  // If the service check already worked out WHY this is down, say the same
  // thing here. Two checks describe one process: while the C920 was unplugged
  // the service line carried "No camera matching 'c920'" and this line still
  // said "fetch failed — try kickstart", which is the wrong advice sitting on
  // the same screen as the right one.
  const cause = DOWN_BECAUSE.get(name === "cleetus-web" ? "web" : name);
  check("http", `${name} answers`, r.status === 200,
    (r.status ? `http ${r.status}` : r.error) + (cause ? ` — ${cause}` : ""),
    cause ? "fix the cause above first — restarting will not help"
          : NO_AGENT[name] || `launchctl kickstart -k gui/$(id -u)/com.cleetus.${name === "cleetus-web" ? "web" : name}`);
  }

  // ── cleetusd internals ──────────────────────────────────────────────────────
  const health = await get("http://127.0.0.1:8767/health");
  if (health.status !== 200) {
    // Same rule as airpad: absent is not passing. If cleetusd itself is not
    // answering these cannot be evaluated, and saying so keeps the set whole.
    for (const n of ["ollama has the model", "vault reachable", "shell enabled"]) {
      skip("cleetusd", n, "cleetusd /health is not answering");
    }
  }
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
  // Asked-for is not the same as capturing.
  //
  // The check above reads the `-i <device>` argument off the running ffmpeg
  // processes, so it reports what each service INTENDED to open. With the BRIO
  // physically unplugged, ffmpeg was still running, the command line still said
  // "Logitech BRIO", and the check said `capturing: Logitech BRIO`.
  //
  // The service knew better and said so in the same breath:
  //
  //   {"camera":{"ok":true,"name":"Logitech BRIO",
  //              "error":"Video device not found ... Input/output error"}}
  //
  // ok:true beside a device-not-found error. Both the service and the panel
  // reported a healthy camera that was sitting on the desk unplugged — which is
  // the exact shape this whole file exists to catch.
  for (const [svc, port] of [["studio-locate", 8765], ["airpad", 8768]]) {
    const st = await get(`http://127.0.0.1:${port}/api/state`, 5000);
    if (st.status !== 200) { skip("cameras", `${svc} camera is really open`, `${svc} is not answering`); continue; }
    let c = null;
    try { c = JSON.parse(st.body).camera || null; } catch {}
    if (!c) { skip("cameras", `${svc} camera is really open`, "no camera block in its state"); continue; }
    const err = String(c.error || "").trim();
    check("cameras", `${svc} camera is really open`, !err,
      err ? `${c.name || "camera"} reports ok but: ${err.split("\n")[0].slice(0, 90)}`
          : `${c.name || "camera"} open, no errors`,
      "the camera is not on the bus — check the cable before restarting anything");
  }

  check("cameras", "addressed by name, not index", !devs.some(d => /^\d+$/.test(d)),
  devs.filter(d => /^\d+$/.test(d)).join(", ") || "all by name",
  "an index binding drifts when AVFoundation reshuffles; restart the service");

  // A check that disappears is not a check that passed.
  //
  // Everything below sits behind "did airpad answer", so when airpad is down
  // the report silently drops four checks and still says "all clear" about the
  // ones that remain. The count changes and nothing says why — the same shape
  // as the flights check that skipped on every run for weeks. When the
  // precondition fails, the checks are emitted as SKIPPED, by name, so the set
  // is always the same length and an absence is visible.
  const pad = await get("http://127.0.0.1:8768/api/state");
  if (pad.status !== 200) {
    for (const n of ["camera producing NEW frames", "frame rate usable",
                     "tracker thread alive", "can move the cursor",
                     "CORS open for the dashboard"]) {
      skip("airpad", n, "airpad is not answering");
    }
  }
  if (pad.status === 200) {
  const p = JSON.parse(pad.body);
  // 10fps means the wrong capture mode was negotiated, which is invisible
  // except as a pointer that feels broken.
  // COUNT DISTINCT FRAMES, NOT DELIVERED ONES.
  //
  // This used to assert `fps > 20`, and `fps` counts arrivals. The camera work
  // in handoff section 24 established that avfoundation pads the stream with
  // duplicates rather than admit it cannot serve a rate: 68 consecutive frames
  // off the wire, one of them distinct, while every counter read 70fps and the
  // multipart stream was byte-perfect. A frozen JPEG is indistinguishable from
  // a very still room, and this check was reading the number that could not
  // tell them apart.
  //
  // `real_fps` counts content changes. When the two disagree, the smaller one
  // is the truth, and the GAP between them is itself the fault signature.
  const arrivals = p.fps ?? 0;
  const distinct = p.real_fps ?? arrivals;
  const padded = arrivals > 4 && distinct > 0 && arrivals / distinct >= 2;
  check("airpad", "camera producing NEW frames", !padded,
    `${distinct} distinct/s of ${arrivals} delivered/s`,
    "duplicate padding — the capture is wedged; the watchdog SIGKILLs and reopens after 2s");
  // The measured ceiling on this C920 is ~19/s at 864x480, so the old >20 bar
  // could never be met by healthy hardware. 6 is "usable pointer".
  check("airpad", "frame rate usable", distinct === 0 || distinct >= 6,
    `${distinct}/s distinct (this C920 tops out near 19)`,
    "see handoff section 24 — resolution barely moves this; the camera negotiated its 20fps mode");
  // The tracker runs on its own thread. When it died, everything downstream
  // kept serving the last annotated frame and looked healthy for hours.
  check("airpad", "tracker thread alive", p.live !== false && !p.tracker_error,
    p.tracker_error ? String(p.tracker_error).slice(0, 90) : `live, ${p.errors ?? 0} errors`,
    "MediaPipe raises on a non-increasing timestamp; the loop is supervised now");
  check("airpad", "can move the cursor", p.accessibility !== false,
    p.accessibility === false ? "Accessibility permission missing" : "accessibility granted",
    "re-tick the python binary under Privacy & Security > Accessibility");
  check("airpad", "CORS open for the dashboard", !!pad.headers.get("access-control-allow-origin"),
    pad.headers.get("access-control-allow-origin") || "missing",
    "without it the dashboard reports the service dead while it runs");
  }

  // ── the briefs may only name tools that exist ──────────────────────────────
  //
  // Renaming a tool silently invalidates every brief that names it, and nothing
  // noticed. Replacing `browse` with the web_* primitives left nine mentions of
  // `browse` across eight briefs — standing instructions to call something no
  // longer in the registry. The agent would try it, get "No such tool", and
  // improvise.
  //
  // Backticked snake_case is the convention in these files for naming a tool,
  // which makes the invariant cheap to check and nearly free of false
  // positives. NOT_A_TOOL holds the handful of backticked identifiers that are
  // legitimately something else — JSON fields, mostly.
  // Only names used AS TOOLS count.
  //
  // The first version flagged every backticked snake_case identifier, on the
  // theory that the convention meant "tool". It does not: the studio brief
  // documents config keys and JSON fields the same way — `engage_hold`,
  // `pinch_close`, `tracker_error` — and the check went red with fourteen false
  // positives at once. The allowlist was already at two entries with a note
  // saying that if it started growing the convention had stopped meaning
  // anything. It grew; so the convention is gone and the check is rebuilt.
  //
  // What actually separates them is CONTEXT. A tool is invoked: "through
  // `cloud_api`", "come from `web_open`", "`web_open` to camelcamelcamel", "Run
  // `vault_search` on the person". A config key is named: "`pinch_close` /
  // `pinch_open` — thumb-to-index", "held `engage_hold` (0.35s)". Only the first
  // shape can be a broken instruction to call something.
  const CALL_BEFORE = /\b(?:use|uses|using|call|calls|run|runs|through|via|with|from|by)\s+$/i;
  // "and" and "with" are out: "`age_ms` and `live` are computed" is a list, not
  // a call. A tool takes "with" BEFORE it ("verified with `web_open`"), never
  // after. The pattern that remains is the one real tool usage takes:
  // "`web_open` to camelcamelcamel", "Run `vault_search` on the person".
  const CALL_AFTER = /^\s*(?:to|on|against|for)\b/i;
  try {
    const { TOOLS } = await import("./tools/index.mjs");
    const files = (await readdir(CONFIG.agentBriefs)).filter(f => f.endsWith(".md"));
    const unknown = new Map();
    for (const f of files) {
      const text = await readFile(join(CONFIG.agentBriefs, f), "utf8");
      // Single words too, not just snake_case. The pattern used to require an
      // underscore, which meant `browse` — the actual tool that actually got
      // removed and actually left nine stale mentions — could never match. The
      // negative control that "proved" this check worked used `browse_the_web`,
      // so it passed for the wrong reason and the real case stayed invisible.
      // Call-context is what filters now, so the identifier shape can be loose.
      for (const m of text.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
        const name = m[1];
        if (TOOLS[name]) continue;
        const before = text.slice(Math.max(0, m.index - 24), m.index);
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
        if (!CALL_BEFORE.test(before) && !CALL_AFTER.test(after)) continue; // named, not invoked
        unknown.set(name, (unknown.get(name) || []).concat(f.replace(".md", "")));
      }
    }
    const bad = [...unknown.entries()].map(([n, fs]) => `${n} (${[...new Set(fs)].join(", ")})`);
    check("cleetusd", "briefs only name tools that exist", bad.length === 0,
      bad.length ? bad.join("; ") : `${files.length} briefs, every named tool resolves`,
      "a brief tells an agent to CALL something that is not in the registry — restore the tool or fix the mention");
  } catch (e) {
    check("cleetusd", "briefs only name tools that exist", false, e.message);
  }

  // ── both halves must be reading the SAME agent briefs ──────────────────────
  //
  // cleetusd reads them off the disk. The web app fetches them as static assets
  // from the deployed site. So the moment a brief is edited and not pushed, the
  // two Cleetuses are running on different instructions — and nothing says so,
  // because both halves are working perfectly from their own point of view.
  //
  // This is not hypothetical: the Opus 5 training pass rewrote all 18 briefs on
  // disk (skin 904 -> 2737 chars, deals 814 -> 4140) and they were never
  // committed. Every specialist in the web app has been answering from the old
  // short brief since, while the same specialist in the deck used the new one.
  //
  // Checked by content length rather than a full diff: the point is to notice
  // divergence, and a length gap is enough to notice.
  try {
    const token = secrets.AUTH_SECRET
      ? createHmac("sha256", secrets.AUTH_SECRET).update("cleetus-internal-subrequest-v1").digest("hex")
      : null;
    if (!token) {
      skip("cleetusd", "agent briefs match the deployed site", "AUTH_SECRET not set");
    } else {
      const ids = ["skin", "deals", "brief", "fashion"];
      const drift = [];
      for (const id of ids) {
        const disk = await readFile(join(CONFIG.agentBriefs, `${id}.md`), "utf8").catch(() => null);
        if (disk === null) continue;
        const r = await fetch(`${CONFIG.cloud}/brain/agents/${id}.md`, {
          headers: { "X-Cleetus-Internal": token }, signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        const live = r && r.ok ? (await r.text()).trim() : null;
        if (live === null) { drift.push(`${id}: site did not serve it`); continue; }
        if (live !== disk.trim()) drift.push(`${id}: disk ${disk.trim().length} vs live ${live.length}`);
      }
      check("cleetusd", "agent briefs match the deployed site", drift.length === 0,
        drift.length ? drift.join("; ") : `${ids.length} sampled, all identical`,
        "the briefs on disk are not deployed — commit and push brain/agents/, which auto-deploys");
    }
  } catch (e) {
    check("cleetusd", "agent briefs match the deployed site", false, e.message);
  }

  // ── what macOS is refusing him ─────────────────────────────────────────────
  //
  // This was visible on the Reach page as three red DENIED rows and nowhere
  // else, which is the wrong place for it: that panel answers "what can he
  // see", and a permission that has silently lapsed is a HEALTH question. It
  // lapses on its own, too — the grant attaches to the versioned Cellar binary,
  // so `brew upgrade node` revokes it without telling anybody (see access.mjs).
  //
  // Deliberately not fatal-sounding when it is only the three library stores:
  // Mail, Messages and Safari behind Full Disk Access is a switch nobody has
  // flipped, not a fault, and the check says which.
  try {
    const a = await accessReport();
    check("access", "macOS is not refusing him anything", a.denied.length === 0,
      a.denied.length
        ? `denied: ${a.denied.join(", ")}${a.needs_full_disk_access.length ? ` (Full Disk Access, for ${a.running_as})` : ""}`
        : `${Object.keys(a.targets).length} locations, all readable`,
      a.fix?.steps?.join(" ") || "");
  } catch (e) {
    check("access", "macOS is not refusing him anything", false, e.message);
  }

  // ── the scheduled jobs actually ran ────────────────────────────────────────
  //
  // The check above asks whether each agent points at a file that exists. That
  // is necessary and it is not sufficient, and the difference is the entire
  // history of this system: ten agents pointed at nothing for three months and
  // the only reason anybody found out was a check written after the fact.
  //
  // A job that runs on schedule and FAILS every time looks identical from
  // launchd's side to one that is working. So this reads what each job wrote
  // about itself. `text-monitor` is expected to fail until Full Disk Access is
  // granted and is called out by name rather than being allowed to keep this
  // permanently red — a check that is always red is one people stop reading.
  try {
    const { JOBS, jobHistory } = await import("./jobs.mjs");
    const hist = await jobHistory();
    const ids = Object.keys(JOBS);
    const failing = ids.filter((id) => hist[id]?.ok === false && id !== "text-monitor");
    const never = ids.filter((id) => !hist[id]);
    check("jobs", "the scheduled jobs are working", failing.length === 0,
      failing.length ? `failing: ${failing.map((id) => `${id} (${hist[id].summary.slice(0, 60)})`).join("; ")}`
        : `${ids.length - never.length}/${ids.length} have run, none failing` +
          (never.length ? ` · not yet run: ${never.join(", ")}` : ""),
      "node ~/cleetusd/bin/job.mjs <id> to run one by hand; ~/cleetus-memory/jobs.log is the record");
  } catch (e) {
    check("jobs", "the scheduled jobs are working", false, e.message);
  }

  // ── the object tracker ─────────────────────────────────────────────────────
  //
  // Two halves that fail differently. The detector needs torch and a weights
  // file it downloads once; the ASSIGNMENT is the quiet one — a Hungarian that
  // is subtly wrong does not throw, it swaps two ids occasionally, which is
  // indistinguishable from ordinary tracker noise and would never be traced
  // back. track_cli.py selftest checks it against brute-force optimal.
  try {
    const raw = await sh(`${PY_CV} ${CONFIG.home}/cleetusd/track_cli.py selftest`);
    const t = JSON.parse(raw);
    check("vision", "object tracker is correct", t.ok === true,
      `hungarian gap ${t.hungarian_max_gap_vs_bruteforce}, identity held through occlusion: ${t.identity_survived_a_six_frame_partial_occlusion}`,
      "cleetusd/track_cli.py — run `selftest` for the detail");
  } catch (e) {
    check("vision", "object tracker is correct", false, e.message,
      `${PY_CV} ${CONFIG.home}/cleetusd/track_cli.py selftest`);
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

  // ── the model actually answers, through the path the web app uses ──────────
  //
  // Reasoning suppression is not a cost optimisation here, it is a cliff. On the
  // OpenAI-compatible /v1 shim, `think:false` is silently ignored; only
  // `reasoning_effort:"none"` stops it. Measured on this box, same question,
  // 200-token budget:
  //
  //   no flag                 200 completion tokens, 913 chars of reasoning,
  //                           and an EMPTY answer — the whole budget went to
  //                           thinking and it never wrote a word
  //   reasoning_effort:none   8 tokens, no reasoning, correct answer, 0.3s
  //
  // One env var (LLM_THINK=1) removes that flag for every call the web app
  // makes. The failure is not slowness, it is blank answers, and the fallback
  // counter is the only other thing that would notice.
  if (secrets.LLM_API_KEY) {
    const base = secrets.LLM_BASE_URL || "https://llm.cleetusai.com/v1";
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.LLM_API_KEY}` },
        body: JSON.stringify({
          model: CONFIG.model, max_tokens: 64, reasoning_effort: "none",
          messages: [{ role: "user", content: "Reply with the single word: ready" }],
        }),
        // A COLD model load is not a fault. Measured against this exact
        // endpoint while it was failing: 93 seconds, correct answer, and the
        // check went green the moment the model was warm. At 45s this called a
        // working model broken — which contradicts the comment above it, where
        // the failure it exists to catch is a BLANK answer, not a slow one.
        signal: AbortSignal.timeout(180_000),
      });
      const j = await r.json();
      const msg = j?.choices?.[0]?.message || {};
      const text = (msg.content || "").trim();
      const reasoned = (msg.reasoning || msg.reasoning_content || "").length;
      check("cloud", "model answers over /v1 without burning the budget", !!text && reasoned === 0,
        text ? `"${text.slice(0, 24)}" · ${j?.usage?.completion_tokens ?? "?"} tokens · ${reasoned} chars reasoning`
             : `EMPTY answer · ${reasoned} chars of reasoning`,
        "reasoning_effort:\"none\" is missing or LLM_THINK=1 — every answer will come back blank");
    } catch (e) {
      // Name which KIND of failure this is. A bare "The operation was aborted
      // due to timeout" sent this session hunting the cloudflared tunnel, which
      // was answering in 0.17s throughout — the model was simply cold.
      check("cloud", "model answers over /v1 without burning the budget", false,
        /timeout|abort/i.test(String(e.message))
          ? `no answer within 180s — a cold load measured 93s, so this is a stall rather than a cold start (${e.message})`
          : e.message);
    }
  } else {
    skip("cloud", "model answers over /v1 without burning the budget", "LLM_API_KEY not set");
  }

  // ── the handoff's own claims, checked ────────────────────────────────────
  //
  // Section 01 of the handoff opens by promising every line was verified
  // against live behaviour. It was — at 22:00 on the night it was written. By
  // morning it claimed 15 tools, 24 checks and 12 access locations, all wrong,
  // and it is the page somebody reads first to decide what deserves attention.
  //
  // Only the mechanically checkable part is asserted: the tool list it prints
  // against the registry that actually exists. Two sets either match or they do
  // not, which does not depend on how carefully anyone read. Prose is left to
  // humans.
  //
  // Desktop access comes and goes on this machine (macOS revoked it from this
  // process for three hours last night), so an unreadable handoff SKIPS. A
  // check that fails because it could not look is noise.
  try {
    const handoff = `${CONFIG.home}/Desktop/Cleetus/CLEETUS-HANDOFF.html`;
    const text = await readFile(handoff, "utf8").catch(() => null);
    if (text === null) {
      skip("cleetusd", "handoff lists the tools that exist", "handoff not readable (macOS TCC)");
    } else {
      // Bounded by the sentence that ENDS the list, not by a character count.
      // A fixed window ran past it into the next sentence and flagged the four
      // alias names it mentions — shell, cat, ls, grep — as ghost tools. Third
      // time a fixed-size window has read something it was not looking at.
      const start = text.search(/The \d+ tools\.<\/b>/);
      const stop = text.indexOf("There is <b>no path allowlist", start);
      const block = start >= 0 && stop > start ? text.slice(start, stop) : "";
      const listed = new Set([...block.matchAll(/<code>([a-z][a-z0-9_]+)<\/code>/g)].map((m) => m[1]));
      const { TOOLS } = await import("./tools/index.mjs");
      const real = new Set(Object.keys(TOOLS));
      const ghost = [...listed].filter((t) => !real.has(t));
      const missing = [...real].filter((t) => !listed.has(t));
      const bad = [...ghost.map((t) => `${t} (gone)`), ...missing.map((t) => `${t} (unlisted)`)];
      check("cleetusd", "handoff lists the tools that exist", listed.size > 0 && bad.length === 0,
        bad.length ? bad.join(", ") : `${listed.size} named, all real`,
        "the handoff's tool list has drifted from the registry — section 46");
    }
  } catch (e) {
    check("cleetusd", "handoff lists the tools that exist", false, e.message);
  }

  // ── the desk light ──────────────────────────────────────────────────────────
  // Unplugged is not a fault — it is a USB device and it travels. What IS a
  // fault is being plugged in and not answering, because the tool would then
  // report "the light is not plugged in" for a light sitting right there.
  const litraUsb = (await sh("ioreg -r -c IOUSBHostDevice -d 1 | grep -c 'Litra'")).trim() !== "0";
  if (litraUsb) {
  const out = await sh(`${PY_CV} ${CONFIG.home}/studio-locate/litra_cli.py state`);
  let state = null;
  try { state = JSON.parse(out); } catch { /* left null */ }
  check("devices", "desk light answers", state?.ok === true && state?.on !== null,
    state ? (state.ok ? `on the bus, power ${state.on ? "on" : "off"}` : state.detail) : "no JSON from litra_cli",
    "hidapi must be in studio-locate/.venv; the vendor HID interface is usage page 0xff43");
  } else {
  skip("devices", "desk light", "not plugged in");
  }

  // ── where a remembered fact actually lands ─────────────────────────────────
  //
  // remember() writes to the VAULT's MEMORY.md when that file is readable and
  // silently falls back to ~/cleetus-memory/MEMORY.md when it is not. Both exist.
  // The vault one is the file Grayson reads in Obsidian; the local one is a
  // stub. So an iCloud hiccup does not fail a write — it quietly redirects it
  // into a file nobody opens, and every fact learned during the outage is
  // stranded there.
  //
  // This session diffed the stub and reported "MEMORY.md unchanged" about the
  // wrong file, which is exactly how the fallback stays invisible.
  {
    const vaultMem = join(CONFIG.vault, "MEMORY.md");
    const localMem = join(CONFIG.memoryRoot, "MEMORY.md");
    const vaultReadable = await readFile(vaultMem, "utf8").then(() => true).catch(() => false);
    const lines = async (p) => (await readFile(p, "utf8").catch(() => "")).split("\n").length;
    const target = vaultReadable ? vaultMem : localMem;
    check("memory", "new facts land where he reads them", vaultReadable,
      vaultReadable
        ? `the vault copy, ${await lines(vaultMem)} lines`
        : `FALLING BACK to ${localMem} (${await lines(localMem)} lines) — the vault copy is unreadable, ` +
          `so anything learned now will not appear in Obsidian`,
      "if this is red, check iCloud: the daemon cannot read the vault MEMORY.md");
    void target;
  }

  // ── no job has run for ever without once doing anything ────────────────────
  //
  // jobs.mjs names this failure at the top of the file: "a job that reports
  // 'nothing to do' when it actually could not look would be the same bug in a
  // new costume". It was right, and there was no check for it.
  //
  // pre-event-brief ran 152 times and 151 of those said "nothing starting in
  // the next 45 minutes". That sentence is also what a correct run says on a
  // quiet evening, which is why nobody looked — but a job that has never once
  // produced a result across months of runs is not quiet, it is broken. The
  // cause was one line that read a bare JSON array as an object.
  //
  // 100% is the threshold rather than "mostly", because a genuinely quiet job
  // has SOME successes: text-monitor sits at 144 quiet runs out of 147 and must
  // not be flagged. What is being caught is never, not seldom.
  {
    const MIN_RUNS = Number(process.env.CLEETUSD_JOB_MIN_RUNS || 20);
    const text = await readFile(join(CONFIG.memoryRoot, "jobs.log"), "utf8").catch(() => "");
    const byJob = new Map();
    for (const line of text.trim().split("\n")) {
      const m = line.match(/^\S+ (ok|FAIL)\s+(\S+) \([\d.]+s\) (.*)$/);
      if (!m) continue;
      const [, , job, summary] = m;
      const e = byJob.get(job) || { runs: 0, empty: 0 };
      e.runs++;
      if (/^(nothing|no |none|0 |not )/i.test(summary)) e.empty++;
      byJob.set(job, e);
    }
    const never = [...byJob].filter(([, e]) => e.runs >= MIN_RUNS && e.empty === e.runs)
                            .map(([j, e]) => `${j} (${e.runs} runs, never once)`);
    const worst = [...byJob].filter(([, e]) => e.runs >= MIN_RUNS)
                            .sort((a, b) => (b[1].empty / b[1].runs) - (a[1].empty / a[1].runs))[0];
    check("services", "every job has done something at least once", never.length === 0,
      never.length ? never.join(", ") + " — it may be unable to see its input"
        : worst ? `quietest is ${worst[0]}, ${worst[1].empty}/${worst[1].runs} runs with no result`
                : `not enough history yet (fewer than ${MIN_RUNS} runs each)`,
      "run it by hand and check what its INPUT looks like, not whether it exits 0");
  }

  // ── no log is running away ─────────────────────────────────────────────────
  //
  // This is the failure that defines the project's history. com.cleetus.chat
  // respawned 423,179 times against a missing script and wrote a 113 MB error
  // log doing it, and NOTHING SURFACED IT FOR THREE MONTHS. That incident is
  // quoted at the top of jobs.mjs, and until now there was no check for it —
  // the lesson was written down and never wired to anything.
  //
  // Nothing rotates these files either: there is no newsyslog rule for them.
  // The threshold sits well above normal (ollama's stderr is legitimately a few
  // MB and grows all day) and well below catastrophic.
  {
    const MAX_MB = Number(process.env.CLEETUSD_MAX_LOG_MB || 50);
    const dir = join(CONFIG.home, "Library/Logs");
    const names = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith("cleetus-") && f.endsWith(".log"));
    const sized = [];
    for (const f of names) {
      const st = await stat(join(dir, f)).catch(() => null);
      if (st) sized.push({ f, mb: st.size / 1e6 });
    }
    sized.sort((a, b) => b.mb - a.mb);
    const big = sized.filter((x) => x.mb > MAX_MB);
    const total = sized.reduce((n, x) => n + x.mb, 0);
    check("services", "no log is running away", big.length === 0,
      big.length
        ? `${big.map((x) => `${x.f} ${x.mb.toFixed(0)}MB`).join(", ")} — a job may be respawning`
        : sized.length
          ? `${sized.length} logs, ${total.toFixed(1)}MB total, largest ${sized[0].f} ${sized[0].mb.toFixed(1)}MB`
          : "no logs yet",
      "read the tail: a giant log is almost always one error repeating, not one big error");
  }

  // ── no tool is failing every time it is called ──────────────────────────────
  //
  // The check above tests two named tools by calling them. This is the same
  // question asked of all thirty-eight at once, from evidence already on disk:
  // every tool call and its result is written into the run files as it happens,
  // so how often each tool actually WORKS is countable.
  //
  // Section 115 counted tools that had never been called. This catches the
  // opposite and worse case — a tool called constantly and failing constantly,
  // which that count cannot see and which is exactly what search_files did for
  // most of 14 August.
  //
  // Honest with itself about its own limit: it only sees tools somebody used.
  // A tool that breaks and then goes untouched for a week stays invisible here,
  // which is why the two checks sit next to each other rather than replacing
  // one another.
  {
    const { toolHealth } = await import("./toolhealth.mjs");
    const th = await toolHealth({ days: 3 });
    const bad = th.alwaysBroken;
    const noisiest = [...th.tools].filter(([, e]) => e.broken).sort((a, b) => b[1].broken / b[1].calls - a[1].broken / a[1].calls)[0];
    check("cleetusd", "no tool is failing every time it is called",
      bad.length === 0,
      bad.length
        ? bad.map((b) => `${b.tool} failed all ${b.calls} calls — ${b.example}`).join("; ")
        : th.tools.size
          ? `${th.tools.size} tools used across ${th.files} runs` +
            (noisiest ? `, worst is ${noisiest[0]} ${noisiest[1].broken}/${noisiest[1].calls}` : ", none failing")
          : `no tool calls in the last ${th.days} days`,
      "call the tool by hand — a tool can fail every time while every service around it looks healthy");
  }

  // ── his search tools still run ──────────────────────────────────────────────
  //
  // search_files and find_files were both written against ripgrep, and ripgrep
  // left this machine sometime on 14 Aug 2026 — present at 11:21, gone by 15:30,
  // with no Homebrew record of it ever being installed. Nothing announced it.
  // Both tools began answering "search failed" to every question, and the only
  // trace was a line buried in a run file that nobody reads unless they already
  // suspect something.
  //
  // The disguise was unusually good: `rg` still resolves when a human types it,
  // because the terminal defines it as a FUNCTION. So every way a person would
  // check said the tool was fine, while every spawn from the daemon got ENOENT.
  //
  // Both now fall back to grep and find, which are in the base system and cannot
  // go missing. This check exists because the fallback is not the lesson — the
  // lesson is that a tool he relies on can stop working and nothing notices. So
  // it CALLS them, on a directory known to contain the answer, and reads what
  // comes back. Config inspection would have said everything was fine.
  {
    const { TOOLS } = await import("./tools/index.mjs");
    const dir = join(CONFIG.home, "cleetusd/src");
    const broke = [];
    let detail = "";
    try {
      const hit = String(await TOOLS.search_files.run({ query: "export const CONFIG", path: dir }));
      if (!hit.includes("config.mjs")) broke.push(`search_files: ${hit.split("\n")[0].slice(0, 90)}`);
      const named = String(await TOOLS.find_files.run({ name: "doctor.mjs", path: dir }));
      if (!named.includes("doctor.mjs")) broke.push(`find_files: ${named.split("\n")[0].slice(0, 90)}`);
      detail = broke.length ? broke.join("; ") : "both answered correctly on a known directory";
    } catch (e) {
      broke.push(`threw: ${e.message.slice(0, 90)}`);
      detail = broke.join("; ");
    }
    check("cleetusd", "his search tools still run", broke.length === 0, detail,
      "call the tool yourself before believing any binary is installed — `rg` resolves as a shell function even when no binary exists");
  }

  // ── the front door ──────────────────────────────────────────────────────────
  //
  // CLEETUSD_TOKEN is the only thing between a stranger and run_shell, the
  // filesystem, and a keyring of real credentials — on a port published through
  // a cloudflared tunnel. If it goes missing the daemon still works perfectly,
  // which is exactly why it needs checking rather than assuming.
  //
  // This PROBES the running daemon instead of reading CONFIG. The failure worth
  // catching is config and reality disagreeing: an env var edited but not
  // reloaded, or a process still running the old value. Reading the same
  // constant the code reads would agree with itself and prove nothing.
  {
    const probe = async (headers) =>
      fetch(`http://127.0.0.1:${CONFIG.port}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ agent: "cleetus", message: "" }),
        signal: AbortSignal.timeout(8_000),
      }).then((r) => r.status).catch((e) => `error ${e.message}`);

    // Forwarding headers make this look like it arrived through the tunnel,
    // which is the case that must never be allowed in without a bearer. Without
    // them a loopback request is deliberately allowed when no token is set.
    const asStranger = await probe({ "x-forwarded-for": "203.0.113.9" });
    check("daemon", "the front door is locked", asStranger === 401,
      asStranger === 401 ? "an unauthenticated tunnelled request is refused"
                         : `an unauthenticated tunnelled request got ${asStranger}, expected 401`,
      "CLEETUSD_TOKEN must be set in ~/Library/LaunchAgents/com.cleetus.cleetusd.plist, then kickstart -k");
  }

  // ── the face recogniser ─────────────────────────────────────────────────────
  //
  // Both halves are checked because they fail differently and only one of them
  // is loud. Missing models make every call return no_models, which is at least
  // an error someone sees. An EMPTY GALLERY is the quiet one: the recogniser
  // runs, finds a face, matches it against nobody and answers "I don't
  // recognise anyone" — which is indistinguishable from a stranger at the desk.
  // Once anyone is enrolled, the gallery going empty means something ate it.
  try {
    const raw = await sh(`${PY_CV} ${CONFIG.home}/cleetusd/face_cli.py list`);
    const g = JSON.parse(raw);
    check("faces", "recogniser runs", g.ok === true, `${g.people?.length ?? 0} enrolled`,
      "the models live in cleetusd/models/face; see cleetusd/face_cli.py");
    check("faces", "someone is enrolled", (g.people?.length || 0) > 0,
      (g.people || []).map((p) => `${p.name} x${p.embeddings}`).join(", ") || "nobody",
      "node ~/cleetusd/bin/face.mjs learn Grayson");
  } catch (e) {
    check("faces", "recogniser runs", false, e.message,
      "the models live in cleetusd/models/face; see cleetusd/face_cli.py");
    check("faces", "someone is enrolled", false, "recogniser did not answer",
      "node ~/cleetusd/bin/face.mjs learn Grayson");
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

  // The flight map, actually checked.
  //
  // This used to skip, every single run, because the endpoint wants a session
  // and the doctor did not have one. A check that always skips is the same as
  // no check — and the thing it was meant to catch is invisible by design: when
  // the Mac's snapshot goes stale the edge sweeps instead, the map still draws,
  // and it silently shows about a quarter of the sky. That is exactly the
  // failure this whole report exists for, and it was the one thing being
  // waved through.
  //
  // The site takes a password login, which cloud_api has been using all along.
  // Borrowing it costs one request.
  let cookie = null;
  if (CONFIG.sitePassword) {
    try {
      const r = await fetch(`${CONFIG.cloud}/api/session/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: CONFIG.cloud },
        body: JSON.stringify({ password: CONFIG.sitePassword }),
        signal: AbortSignal.timeout(15_000),
      });
      const sc = (r.headers.getSetCookie?.() || [])
        .map((c) => c.split(";")[0])
        .filter((c) => c.startsWith("cleetus_session="));
      cookie = sc.length ? sc.join("; ") : null;
    } catch { /* reported below */ }
  }
  check("cloud", "can log into the site", !!cookie,
    cookie ? "session obtained" : CONFIG.sitePassword ? "login failed" : "SITE_PASSWORD not set",
    "without this the flight check cannot run at all");

  if (!cookie) {
    for (const n of ["flights swept by the Mac", "flight data not degraded"]) {
      skip("cloud", n, "could not log into the site");
    }
    skip("cloud", "integrations healthy", "could not log into the site");
  }
  if (cookie) {
    let flights;
    try {
      const r = await fetch("https://cleetusai.com/api/flights?count=1", {
        headers: { Cookie: cookie }, signal: AbortSignal.timeout(20_000),
      });
      flights = { status: r.status, body: await r.text() };
    } catch (e) { flights = { status: 0, error: e.message }; }

    if (flights.status === 200) {
      try {
        const f = JSON.parse(flights.body);

        // A 200 is not an answer.
        //
        // This endpoint returns HTTP 200 with a body of
        // {"ok":false,"error":"no_adsb_feed_reachable"} when it cannot reach any
        // feed — no swept_by, no in_air, no degraded. Observed live during the
        // outage this morning.
        //
        // That made the degraded check report GREEN, because `!f.degraded` is
        // true when the field is absent: "flight data not degraded: ok" while
        // the server was saying it could not reach a single feed. An absent
        // field is unknown, not healthy, and this is the worst kind of green.
        if (f.ok === false || f.swept_by === undefined) {
          const why = f.error || "no swept_by in the response";
          check("cloud", "flights swept by the Mac", false,
            `the endpoint answered 200 but reported: ${why}`,
            "the feed side is failing, not the Mac — check the ingest before restarting anything");
          check("cloud", "flight data not degraded", false,
            `cannot tell — the endpoint returned "${why}" instead of a reading`,
            "an absent 'degraded' field is unknown, not healthy");
        } else {
        // When this is red, say WHICH SIDE failed.
        //
        // It read the served data and blamed the Mac, advising "kickstart
        // com.cleetus.flights". During a real outage that advice was wrong: the
        // sweeper had just logged "2893 aircraft, 20/20 anchors, adsb, 12.0s"
        // and pushed them, and the INGEST answered {"ok":false,"stored":2893}.
        // The Mac did its job and the panel told the reader to restart it.
        //
        // The sweeper's own log is the only place that separates "not sweeping"
        // from "swept, and the write was refused".
        const localSweep = await (async () => {
          const log = await readFile(join(CONFIG.home, "Library/Logs/cleetus-flights.err.log"), "utf8").catch(() => "");
          if (!log) return null;
          const tail = log.slice(-4000);
          const sweeps = [...tail.matchAll(/^(\d+) aircraft, (\d+\/\d+) anchors/gm)];
          if (!sweeps.length) return null;
          const pushes = [...tail.matchAll(/^push: \d+ (\{.*\})$/gm)];
          let pushOk = null;
          if (pushes.length) { try { pushOk = JSON.parse(pushes[pushes.length - 1][1]).ok; } catch {} }
          const last = sweeps[sweeps.length - 1];
          return { aircraft: Number(last[1]), anchors: last[2], pushOk };
        })();

        const macIsServing = f.swept_by === "mac-studio";
        const macSwept = !!(localSweep && localSweep.aircraft > 0);
        check("cloud", "flights swept by the Mac", macIsServing,
          macIsServing
            ? `${f.swept_by} · ${f.in_air} aircraft · ${f.anchors_answered}/${f.anchors} anchors`
            : macSwept
              ? `serving ${f.swept_by} (${f.in_air} aircraft) — but the Mac DID sweep ${localSweep.aircraft} ` +
                `aircraft, ${localSweep.anchors} anchors` +
                (localSweep.pushOk === false ? "; the ingest answered ok:false, so the write is being refused" : "")
              : `${f.swept_by} · ${f.in_air} aircraft · ${f.anchors_answered}/${f.anchors} anchors — the Mac has not swept`,
          macSwept
            ? "do NOT restart the sweeper, it is working — the ingest is refusing the write"
            : "launchctl kickstart -k gui/$(id -u)/com.cleetus.flights");
        // Degraded is the edge saying so out loud. Believe it.
        check("cloud", "flight data not degraded", !f.degraded,
          f.degraded ? `degraded: ${f.source}` : `source ${f.source}`,
          "the Mac's snapshot went stale; check com.cleetus.flights");
        }
      } catch { check("cloud", "flights readable", false, "unparseable"); }
    } else {
      check("cloud", "flights endpoint", false, `http ${flights.status || flights.error}`);
    }
  }

  // ── the cloud app's own verdict, surfaced here ─────────────────────────────
  //
  // /api/health grades eight integrations and nothing on this machine was
  // reading it, so a red pill on a page nobody had open was the only signal.
  // Pulled in here it lands in the same report as everything else.
  //
  // Its own checks have been over-generous — outlook returned
  // {ok:true, connected:false} and was graded "connected" — so a green here
  // means "the cloud app believes it is fine", which is worth exactly as much
  // as that endpoint's own honesty. Reported as one line, named per check.
  if (cookie) {
    try {
      const r = await fetch(`${CONFIG.cloud}/api/health`, {
        headers: { Cookie: cookie }, signal: AbortSignal.timeout(60_000),
      });
      const h = await r.json();
      const down = Object.entries(h.checks || {}).filter(([, v]) => !v.ok).map(([k]) => k);
      check("cloud", "integrations healthy", down.length === 0,
        down.length ? `down: ${down.join(", ")}` : `${Object.keys(h.checks || {}).length} checks, all green`,
        "open /api/health for the per-integration detail");
    } catch (e) {
      check("cloud", "integrations healthy", false, e.message);
    }
  }

  return { results, failed: results.filter((r) => !r.ok && !r.skipped) };
}
