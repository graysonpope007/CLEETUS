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
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG, secrets } from "./config.mjs";
import { accessReport } from "./access.mjs";

const run = promisify(execFile);
const sh = (c) => run("/bin/zsh", ["-lc", c], { timeout: 20_000 }).then(r => r.stdout).catch(e => e.stdout || "");

// The one Python on this machine with OpenCV and hidapi in it. Both the light
// and the face recogniser are studio-locate's dependencies borrowed rather than
// duplicated, so they borrow the same interpreter.
const PY_CV = process.env.CLEETUSD_PYTHON || `${CONFIG.home}/studio-locate/.venv/bin/python`;

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
  ["com.cleetus.studio", "studio-locate, the BRIO"],
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
  check("http", `${name} answers`, r.status === 200,
    r.status ? `http ${r.status}` : r.error,
    NO_AGENT[name] || `launchctl kickstart -k gui/$(id -u)/com.cleetus.${name === "cleetus-web" ? "web" : name}`);
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
        signal: AbortSignal.timeout(45_000),
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
      check("cloud", "model answers over /v1 without burning the budget", false, e.message);
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
        check("cloud", "flights swept by the Mac", f.swept_by === "mac-studio",
          `${f.swept_by} · ${f.in_air} aircraft · ${f.anchors_answered}/${f.anchors} anchors`,
          "launchctl kickstart -k gui/$(id -u)/com.cleetus.flights");
        // Degraded is the edge saying so out loud. Believe it.
        check("cloud", "flight data not degraded", !f.degraded,
          f.degraded ? `degraded: ${f.source}` : `source ${f.source}`,
          "the Mac's snapshot went stale; check com.cleetus.flights");
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
