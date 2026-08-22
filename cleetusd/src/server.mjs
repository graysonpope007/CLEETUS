// src/server.mjs — the door.
//
// Loopback only. Everything that reaches the outside world does so through the
// existing cloudflared tunnel with Caddy's bearer gate in front, the same shape
// llm.cleetusai.com already uses. Binding this to 0.0.0.0 would put an
// unauthenticated shell on the coffee-shop wifi.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";
import { isLocalBrowser, authed } from "./gate.mjs";
import { senseRoom, passthrough as ruviewPassthrough } from "./tools/ruview.mjs";
import { ask, route } from "./agent.mjs";
import { agentList } from "./agents.mjs";
import { health as ollamaHealth, visionReady } from "./ollama.mjs";
import { loadSkills, recentRuns } from "./memory.mjs";
import { DASHBOARD } from "./ui.mjs";
import { vaultReachable } from "./tools/index.mjs";
import { accessReport } from "./access.mjs";
import { litraRaw } from "./tools/devices.mjs";
import { runDoctor } from "./doctor.mjs";
import { repoIndex } from "./repos.mjs";
import { listMedia, probeDuration, safeAsset, exportTimeline, kindOf, MEDIA_DIR } from "./editor.mjs";
import { createReadStream, existsSync } from "node:fs";
import { extname } from "node:path";
import * as keyring from "./keyring.mjs";
import * as convos from "./conversations.mjs";

// Cached answer for /presence — see the route for why 8 seconds.
let presenceCache = { at: 0, value: null };
// The most recent NAMED sighting, kept separately from the cache.
//
// A face recogniser needs a face. Look down at the bench, turn to the rack, and
// the name vanishes while the person plainly has not — which on a wall panel
// reads as the room emptying every time you glance away. So a name persists for
// a couple of minutes and is reported WITH its age, and the panel can say
// "seen 40s ago" instead of flickering between a name and nobody.
let lastNamed = { names: [], at: 0 };
import { acceptDrop, attachmentLine, listDrops } from "./drops.mjs";

/* Every request header the browser is allowed to send across an origin.
   This is one constant rather than two string literals because the two used to
   drift, and the drift was invisible: /reach opened from cleetusai.com talks to
   this daemon at 127.0.0.1:8767, which is a DIFFERENT ORIGIN, so an upload is
   preflighted — and X-Drop-Name, which is the entire way a dropped file's name
   reaches this process, was not named here. Chrome then refused to send the
   real request, and fetch reported that refusal as a bare
   `TypeError: Failed to fetch` — the same words it uses for a daemon that is
   down. So every drop from the site failed while curl and the deck at
   127.0.0.1:8767 both passed, because neither of those crosses an origin.

   Anything the page starts sending belongs here the same day it is added. */
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Drop-Name";

// Last health pass, shared by every caller. See the /doctor route.
const DOCTOR_TTL = 60_000;
const doctorCache = { data: null, at: 0, running: null, error: null };

function json(res, data, status = 200) {
  // Guarded here so every caller is safe, rather than auditing each catch block
  // and hoping. Several error paths call json() after a response has already
  // begun — the airpad state route can, if the write of a good response throws —
  // and a second writeHead raises ERR_HTTP_HEADERS_SENT, which inside an async
  // handler used to end the whole process rather than the request.
  if (res.headersSent) return res.end();
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}



// One bad request must not take the assistant down.
//
// An exception inside an async handler becomes an unhandled rejection, and Node
// exits the process on those. That is the correct default for a script and the
// wrong one for a daemon somebody talks to: a single malformed request, or a
// camera proxy tripping over its own headers, killed cleetusd and every
// unrelated conversation in flight with it.
//
// So the handler is wrapped. Genuine faults still get logged loudly and still
// show up in the run files and the doctor; they just stop being fatal to
// everything else happening at the time.

/**
 * When the current failure streak for a check began.
 *
 * Walks the health log backwards while the check keeps appearing and returns
 * the timestamp of the oldest consecutive line naming it. A check that failed
 * yesterday, recovered, and failed again an hour ago reports an hour — which is
 * the honest answer, and the reason this walks a streak rather than grepping
 * for the first occurrence ever.
 */
function sinceFor(lines, name) {
  const slug = name.replace(/\s+/g, "-");
  let since = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(slug)) break;
    since = lines[i].slice(0, 24);
  }
  return since;
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[cleetusd] request failed:", req.method, req.url, e?.stack || e);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "handler_failed", detail: String(e?.message || e) }));
      } else {
        res.end();
      }
    } catch { /* the socket is already gone; nothing left to say */ }
  });
});

// Whether any turn in this conversation carries a picture.
const hasImages = (history) =>
  history.some((m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === "image"));

async function handle(req, res) {
  const url = new URL(req.url, `http://${CONFIG.host}:${CONFIG.port}`);

  // ── CORS preflight ──
  // The /reach page is served from https://cleetusai.com and calls back down to
  // this loopback port. Two separate browser rules apply and BOTH have to be
  // answered or the call never arrives:
  //
  //   Mixed content — normally an HTTPS page may not fetch http://. 127.0.0.1
  //   is exempt because loopback counts as a trustworthy origin, which is the
  //   entire reason the page talks to 127.0.0.1 and not to the tailnet IP.
  //
  //   Private Network Access — a public site reaching a private address gets a
  //   preflight carrying Access-Control-Request-Private-Network, and the
  //   browser drops the real request unless the response grants it explicitly.
  //   Nothing in the page can work around a missing header here; it presents as
  //   a CORS failure with a body that never left the machine.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }

  if (url.pathname === "/health") {
    const [o, skills, vaultOk] = await Promise.all([
      ollamaHealth(),
      loadSkills().catch(() => []),
      vaultReachable(),
    ]);
    return json(res, {
      ok: o.ok,
      model: CONFIG.model,
      ollama: o,
      // Memory writes go here and always work. The vault is a bonus.
      memory_root: CONFIG.memoryRoot,
      skills: skills.length,
      vault: {
        path: CONFIG.vault,
        reachable: vaultOk,
        // Under launchd this is false and that is expected, not a fault:
        // iCloud does not serve daemons. Said out loud so a blocked vault is
        // never mistaken for an empty one.
        detail: vaultOk ? "readable" : "blocked (iCloud does not serve launchd agents)",
      },
      shell: CONFIG.shellEnabled,
      agents: agentList().length,
    });
  }

  if (url.pathname === "/agents") return json(res, { agents: agentList() });

  // What of the machine this process can actually see. Public alongside
  // /health because it reports reachability, never file contents.
  if (url.pathname === "/access") return json(res, await accessReport());

  // ── The browser surface ──
  // A browser cannot attach an Authorization header to a top-level navigation,
  // so the dashboard and the calls it makes are admitted on the strength of
  // isLocalBrowser instead. Anything arriving through a proxy — including a
  // future cloudflared hop, which also connects from 127.0.0.1 — falls through
  // to the bearer gate below like every other request.
  const BROWSER_ROUTES = ["/", "/index.html", "/skills", "/runs", "/chat/stream",
                          "/airpad/state", "/airpad/stream.mjpg",
                          "/light", "/doctor", "/repos", "/secrets", "/conversations",
                          "/editor", "/editor/media", "/editor/asset", "/editor/probe",
                          "/editor/export",
                          // Dropping a file on a chat window is part of asking a
                          // question, so it is admitted exactly as /chat/stream is
                          // and for the same reason: this machine's own browser
                          // cannot attach an Authorization header, and being on
                          // this list is what lets it through without one.
                          //
                          // Being here ADDS the local-browser door; it does not
                          // close the bearer one. So a phone over the tunnel can
                          // send a photo, with a token, exactly as it can send a
                          // message. That is the right level: /chat already hands
                          // a token-holder this daemon's shell, so refusing them a
                          // write into one drops folder would guard nothing while
                          // costing the only way to get a picture off a phone.
                          "/upload", "/drops",
                          // /reach is the deck's own page served from here, so a
                          // browser ON this Mac never has to cross an origin to
                          // talk to the daemon. Same gate as the dashboard:
                          // this machine only, no forwarding headers, so the
                          // tunnel cannot reach it whatever token it carries.
                          "/reach", "/favicon.svg",
                          // /room is the RuView sensing fleet. It has to be
                          // served from here rather than read from the sensing
                          // server directly, because that server sends NO CORS
                          // headers at all — so a page on cleetusai.com asking
                          // 127.0.0.1:3000 for the room is refused by the
                          // browser before the request is made, whatever the
                          // page's CSP says. Being on this list also leaves the
                          // bearer door open, which is how a phone reads the
                          // room over the tunnel without a second hostname.
                          "/room", "/presence"];
  const localBrowser = isLocalBrowser(req) &&
    (BROWSER_ROUTES.includes(url.pathname) || url.pathname.startsWith("/conversations/") ||
     // A prefix, because /ruview reads a dozen endpoints off the sensing server
     // and listing each one here would be a list that goes stale the first time
     // the page grows a panel. Everything under it is already narrowed to the
     // read-only allowlist in tools/ruview.mjs before anything is fetched.
     url.pathname.startsWith("/ruview/"));

  // ── Anything that moves the cursor ──
  // Deliberately NOT bearer-gated like the rest, because the bearer is exactly
  // what the tunnel carries: /api/reach on Cloudflare holds a valid token, so a
  // bearer check would let anyone who reached the site move this Mac's mouse
  // and click with it. These require the request to have originated on the
  // machine itself — loopback peer, no forwarding headers — which a request
  // through cloudflared can never look like, valid token or not.
  // /airpad/span belongs here for the same reason as the rest: it decides
  // WHICH SCREENS the pointer can reach, and "all of them" is a bigger grant
  // than picking one — so it answers to this Mac only, token or no token.
  const CURSOR_ROUTES = ["/airpad/control", "/airpad/display", "/airpad/span",
                         "/airpad/accessibility"];
  // Calibration writes thresholds that decide what the cursor does, so it lives
  // behind the same local-only gate — and it is a prefix rather than a list
  // because these are nested (/airpad/calibrate/scroll/fit) and there are eight
  // of them. The studio page drives all of them from the browser.
  if (CURSOR_ROUTES.includes(url.pathname) || url.pathname.startsWith("/airpad/calibrate/")) {
    if (!isLocalBrowser(req)) {
      return json(res, {
        ok: false,
        error: "not_local",
        detail: "Cursor control only answers from this Mac. Open the deck at " +
                "127.0.0.1:8767, or reach it over Tailscale.",
      }, 403);
    }
    const target = url.pathname.replace("/airpad/", "");
    try {
      const r = await fetch(`http://127.0.0.1:8768/api/${target}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await readBody(req)),
        signal: AbortSignal.timeout(4000),
      });
      return json(res, await r.json(), r.status);
    } catch (e) {
      return json(res, { ok: false, error: "airpad_unreachable", detail: e.message }, 502);
    }
  }

  if (!localBrowser && !authed(req)) return json(res, { ok: false, error: "unauthorized" }, 401);

  // The dashboard. Same origin as the API on purpose — see ui.mjs.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(DASHBOARD);
  }

  // ── The editor ──
  // A built-in cutting room over the media agent's output folder. The page is a
  // single file read from disk (like reach.html on the web side), and it talks
  // only to these same-origin routes; the ffmpeg export lives in editor.mjs.
  // Every asset path from the browser is fenced to the media folder before it
  // reaches disk or ffmpeg — see safeAsset — because here a path is a capability.
  if (url.pathname === "/editor") {
    const file = join(CONFIG.home, "cleetusd", "editor.html");
    if (!existsSync(file)) return json(res, { ok: false, error: "editor.html missing" }, 404);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(await readFile(file, "utf8"));
  }

  /* ── /reach, served from HERE ───────────────────────────────────────────────
     The same file cleetusai.com serves, handed out by the daemon it talks to.

     Not because the cross-origin path was broken — it works, /reach carries a
     CSP naming http://127.0.0.1:8767 and the loopback probe succeeds. Because
     the cross-origin path is FRAGILE in a way this one is not. It depends on a
     CSP carve-out in a middleware file in another repo, on a 1.5s probe
     succeeding, and on the browser continuing to allow a public page to reach a
     loopback address, which is exactly the kind of permission browsers keep
     tightening. When any of those goes, the page does not break loudly: it
     falls through to the tunnel while sitting on the machine it wanted, and the
     tunnel has a measured ceiling —

         POST https://me.cleetusai.com/chat  ->  524 after 125.2s

     — so it turns every slow answer into a failure. Served from here there is
     no origin to cross, nothing to probe, no Cloudflare in the path and no
     ceiling. The marker injected below is how the page knows.

     Read from disk per request rather than baked in, like /editor, so editing
     reach.html in cleetusv2 and reloading is the whole edit cycle. */
  if (url.pathname === "/reach") {
    const file = join(CONFIG.home, "cleetusv2", "reach.html");
    if (!existsSync(file)) {
      return json(res, { ok: false, error: "reach.html missing",
        detail: `Expected it at ${file} — that is the copy cleetusai.com serves.` }, 404);
    }
    let html = await readFile(file, "utf8");
    // lock.js is the site's Touch ID gate and lives on cleetusai.com. It cannot
    // load from here, and left in place it 404s on every request; the gate that
    // matters for this origin is isLocalBrowser, which already ran above.
    html = html.replace('<script src="/lock.js"></script>',
      "<script>window.__CLEETUSD_ORIGIN__ = true;</script>");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }

  // The one asset /reach asks for by absolute path. Without it the tab shows a
  // 401 in the console and a blank favicon, which reads as something being
  // wrong with the page when nothing is.
  if (url.pathname === "/favicon.svg") {
    const file = join(CONFIG.home, "cleetusv2", "favicon.svg");
    if (!existsSync(file)) return json(res, { ok: false, error: "not found" }, 404);
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
    return res.end(await readFile(file, "utf8"));
  }
  /* ── /upload — a file dropped on a chat window ──────────────────────────────
     The body IS the file. No multipart, no form encoding, no parser: the name
     rides in a header and the bytes are the request, which is what lets this
     stream straight to disk instead of assembling a phone video in memory
     inside the daemon everything else is also living in.

     What comes back is not an id to be redeemed later, it is the whole
     description — the path on disk, a downscaled picture when there is one to
     look at, the extracted words when there are any, and the sentence that
     goes into the conversation. The browser's job is then only to attach it,
     and both chat windows attach it the same way because the wording is made
     here rather than in either page.  See drops.mjs. */
  if (url.pathname === "/upload" && req.method === "POST") {
    const name = decodeURIComponent(String(req.headers["x-drop-name"] || "file"));
    const mime = String(req.headers["content-type"] || "");
    try {
      const d = await acceptDrop(req, { name, mime });
      return json(res, { ...d, line: attachmentLine(d) });
    } catch (e) {
      // The reasons a drop fails are things a person can act on — too big, an
      // empty file, a full disk — so they are said in those words rather than
      // as a 500 the page reports as "something went wrong".
      return json(res, { ok: false, error: e.message }, 400);
    }
  }

  // Everything dropped so far, newest first. The chat writes the path into the
  // message, so this is for the human who wants yesterday's file back without
  // going through the thread to find what it was called.
  if (url.pathname === "/drops") {
    return json(res, { ok: true, items: await listDrops() });
  }

  if (url.pathname === "/editor/media") {
    return json(res, { ok: true, items: await listMedia() });
  }
  if (url.pathname === "/editor/probe") {
    const abs = safeAsset(url.searchParams.get("path"));
    if (!abs) return json(res, { ok: false, error: "no such asset" }, 404);
    return json(res, { ok: true, duration: await probeDuration(abs) });
  }
  if (url.pathname === "/editor/asset") {
    const abs = safeAsset(url.searchParams.get("path"));
    if (!abs) return json(res, { ok: false, error: "asset outside media folder" }, 403);
    const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime",
      ".m4v": "video/mp4", ".webm": "video/webm" };
    const headers = {
      "Content-Type": TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    // The download link in /reach is cross-origin (cleetusai.com → 127.0.0.1),
    // and the HTML `download` attribute is ignored cross-origin — only a
    // Content-Disposition from here forces a save instead of a navigation. So a
    // dl=1 flag turns this response into an attachment.
    if (url.searchParams.get("dl") === "1") {
      headers["Content-Disposition"] = `attachment; filename="${abs.split("/").pop()}"`;
    }
    res.writeHead(200, headers);
    // Stream rather than buffer: a video clip can be tens of MB and the preview
    // pane seeks into it, so handing it as a file stream is both lighter and
    // what lets the <video> element range-request.
    return createReadStream(abs).on("error", () => res.end()).pipe(res);
  }
  if (url.pathname === "/editor/export" && req.method === "POST") {
    const timeline = await readBody(req);
    const out = join(MEDIA_DIR, `cut_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.mp4`);
    return json(res, await exportTimeline(timeline, out));
  }

  // ── The air trackpad, proxied ──
  // The dashboard used to fetch 127.0.0.1:8768 directly. Same machine, but a
  // different ORIGIN, so it is subject to CORS and to Chrome's private-network
  // rules, and a blocked request is indistinguishable in the page from the
  // service being down — which is exactly how a running trackpad got reported
  // as "not running" and then as a blank box. Proxying makes it same-origin,
  // which removes the entire class of failure rather than working around it.
  if (url.pathname === "/airpad/state") {
    try {
      const r = await fetch("http://127.0.0.1:8768/api/state", { signal: AbortSignal.timeout(2000) });
      const body = await r.text();
      // The CORS header has to be set here too. This route writes its own
      // headers rather than going through json(), which was invisible for as
      // long as the only caller was the dashboard on this same origin — and
      // then /reach, served from cleetusai.com, got a bare ERR_FAILED that
      // reads in the page as "the tracker is down" while it is running fine.
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
      }
      return res.end(body);
    } catch (e) {
      return json(res, { ok: false, error: "airpad_unreachable", detail: e.message });
    }
  }

  if (url.pathname === "/airpad/stream.mjpg") {
    try {
      // NO total timeout. AbortSignal.timeout bounds the WHOLE request, not
      // just the connect, so a 5s timeout killed the feed after five seconds —
      // which is exactly the "shows for a second then goes blank" symptom. An
      // MJPEG stream is meant to never finish; the only thing that should end
      // it is the browser going away, handled by the req close below.
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const r = await fetch("http://127.0.0.1:8768/stream.mjpg", { signal: ctrl.signal });
      res.writeHead(200, {
        "Content-Type": r.headers.get("content-type") || "multipart/x-mixed-replace; boundary=f",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      // Pump it through. The stream never ends, so this holds the socket open
      // until the browser goes away — which is what an MJPEG feed is.
      const reader = r.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((ok) => res.once("drain", ok));
        }
      }
      return res.end();
    } catch {
      // The failure can happen at two completely different moments and only one
      // of them can still send a status.
      //
      // Before the pump starts, nothing has been written and a 502 is honest:
      // this endpoint exists, the thing behind it does not. Once the 200 above
      // has gone out, the headers are spent — and calling writeHead again
      // throws ERR_HTTP_HEADERS_SENT, from inside an async handler, which takes
      // the WHOLE DAEMON down. It did: airpad hiccupped mid-stream, cleetusd
      // exited 1, and every unrelated request in flight died with it, including
      // three long-running chat calls that had nothing to do with the camera.
      //
      // A video that stops is a video that stops. End the response and let the
      // browser reconnect, which is what an <img> on an MJPEG stream does.
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        return res.end("airpad not reachable on 127.0.0.1:8768");
      }
      return res.end();
    }
  }

  // ── Health ──
  // Cached, because a full pass touches the network, USB and three launchd
  // agents; a dashboard polling that every few seconds would itself become a
  // load problem. Stale-while-revalidate: answer instantly from the last pass
  // and kick off a new one in the background, and always say HOW OLD the
  // answer is, so a frozen doctor cannot masquerade as a healthy one.
  if (url.pathname === "/doctor") {
    const now = Date.now();
    const fresh = doctorCache.at && now - doctorCache.at < DOCTOR_TTL;
    if (!fresh && !doctorCache.running) {
      doctorCache.running = runDoctor()
        .then((r) => { doctorCache.data = r; doctorCache.at = Date.now(); })
        .catch((e) => { doctorCache.error = e.message; })
        .finally(() => { doctorCache.running = null; });
    }
    // First call of the process has nothing cached; wait for it rather than
    // returning an empty all-clear, which would read as "everything is fine".
    if (!doctorCache.data) await doctorCache.running;
    const d = doctorCache.data;
    // How long has each of these been failing?
    //
    // The health log records one line per run (com.cleetus.health, every 15
    // minutes). Reading the current failure streak out of it turns "plaid is
    // down" into "plaid has been down since 21:00", which is the difference
    // between a reading and a diagnosis — and the thing that took six hours of
    // manual re-running to establish the first time.
    const logLines = await readFile(join(CONFIG.memoryRoot, "health.log"), "utf8")
      .then((t) => t.split("\n").filter(Boolean))
      .catch(() => []);
    const failed = d ? d.failed.map((f) => ({ ...f, since: sinceFor(logLines, f.name) })) : [];
    return json(res, {
      ok: !!d && d.failed.length === 0,
      age_seconds: doctorCache.at ? Math.round((Date.now() - doctorCache.at) / 1000) : null,
      checks: d ? d.results.length : 0,
      failed,
      results: d ? d.results : [],
      error: doctorCache.error || null,
    });
  }

  // ── The desk light ──
  // Raw device JSON, not the sentence the LLM tool returns: the deck needs a
  // boolean it can colour a dot with, and putting a language model between a
  // button and a light would be absurd.
  if (url.pathname === "/light") {
    const action = url.searchParams.get("action") || "state";
    const value = url.searchParams.get("value");
    const args = value === null ? [action] : [action, value];
    return json(res, await litraRaw(...args));
  }

  // ── The room ──
  // Raw JSON with the trust verdict attached, on the same principle as /light:
  // the deck needs a value it can gate a rendering on, and the sentence version
  // belongs to the model's tool, not to a canvas.
  //
  // The `trustworthy` flag and `reasons` are the point of this route. The
  // sensing server answers 200 with invented people on it, so a surface that
  // simply relayed its JSON would be handing every caller a number that looks
  // measured and is not. One place computes the verdict — src/tools/ruview.mjs
  // — and the tool, the doctor, the deck and /ruview all read it from there,
  // rather than each keeping its own opinion about the same hardware.
  if (url.pathname === "/room") {
    return json(res, await senseRoom());
  }

  // ── Who is actually in the room, from the eye that can tell ──
  //
  // /room answers honestly that the WiFi sensing cannot say. That is correct and
  // it is also useless to a panel on the wall, which then shows "CANNOT TELL"
  // while a camera pointed at the same room knows the person's NAME. The sensor
  // that works should be the one that answers the question.
  //
  // Cached for 8 seconds. The face recogniser spawns a Python process and takes
  // a second or two; a wall panel polling every 5 s would otherwise keep one
  // running permanently for a number that cannot meaningfully change that fast.
  if (url.pathname === "/presence") {
    const age = Date.now() - presenceCache.at;
    if (!presenceCache.value || age > 8_000) {
      try {
        const rw = await import("./roomwatch.mjs");
        const [probe, who, base] = await Promise.all([
          rw.cameraProbe({ frames: 4, gapMs: 200, tag: "presence" }),
          rw.whoIsThere(),
          rw.loadBaseline(),
        ]);
        const trip = base?.camera?.trip ?? 0.5;

        // THE DESK IS A DIFFERENT QUESTION FROM THE ROOM, and the camera cannot
        // answer it. The C920 points across the room at the door — which is
        // right for the alarm — so a person sitting at the desk is BEHIND it,
        // facing away, with the chair back in the way. The Brio that does look
        // at the desk has delivered zero frames since it was installed.
        //
        // com.cleetus.desk-trigger has been answering this correctly the whole
        // time from HID idle time: keyboard and mouse activity is a direct
        // measurement of someone using the desk, not an inference about it.
        let desk = null;
        try {
          const raw = await readFile(join(CONFIG.home, "desk-trigger", "state.json"), "utf8");
          const d = JSON.parse(raw);
          desk = { at_desk: Boolean(d.at_desk), idle_seconds: d.idle_seconds ?? null, since: d.since ?? null };
        } catch { /* the service may not be running; the camera half still answers */ }
        if (who.ok && who.named.length) lastNamed = { names: who.named, at: Date.now() };
        presenceCache = {
          at: Date.now(),
          value: {
            ok: true,
            // A frozen stream is NOT a still room, and saying "nobody here"
            // because the capture stalled is the one answer this must never
            // give. Reported as its own state.
            camera: probe.ok ? (probe.frozen ? "frozen" : "live") : "down",
            moving: probe.ok && !probe.frozen ? probe.max_changed_pct >= trip : null,
            changed_pct: probe.ok ? probe.max_changed_pct : null,
            trip,
            named: who.ok ? who.named : [],
            // who was here recently, even if no face is toward the lens now
            recent_names: lastNamed.names,
            recent_age_ms: lastNamed.at ? Date.now() - lastNamed.at : null,
            unknown_faces: who.ok ? who.unknown : null,
            faces: who.ok ? who.faces : null,
            face_error: who.ok ? null : who.why,
            desk,
          },
        };
      } catch (e) {
        presenceCache = { at: Date.now(), value: { ok: false, error: String(e.message || e).slice(0, 140) } };
      }
    }
    return json(res, { ...presenceCache.value, age_ms: Date.now() - presenceCache.at });
  }

  // ── The sensing server itself, read-only ──
  //
  // WHY THIS PROXY EXISTS AT ALL, given the page could just ask port 3000.
  // It cannot. The sensing server sends no Access-Control-Allow-Origin on any
  // response and has no flag to make it (checked against --help), so a page on
  // cleetusai.com is refused by the browser before the request leaves it. On
  // top of that Chrome requires a private-network preflight for a public origin
  // reaching 127.0.0.1, answered with Access-Control-Allow-Private-Network —
  // which this daemon sends and that one does not. Both doors are shut, and
  // neither failure appears anywhere except the browser console, which is why
  // /ruview has been showing "No route from here" while the server sat there
  // answering every request put to it on the command line.
  if (url.pathname.startsWith("/ruview/")) {
    const r = await ruviewPassthrough(url.pathname.slice("/ruview/".length), url.search);
    if (res.headersSent) return res.end();
    res.writeHead(r.status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Cache-Control": "no-store",
    });
    return res.end(r.body);
  }

  if (url.pathname === "/skills") {
    const skills = await loadSkills().catch(() => []);
    return json(res, { skills: skills.map((s) => ({ title: s.title, when: s.when, file: s.file })) });
  }

  if (url.pathname === "/runs") {
    return json(res, { runs: await recentRuns().catch(() => []) });
  }

  // ── The repositories ──
  // Read-only, and it is a list of paths and names rather than any code, so it
  // is safe over the tunnel. ?refresh=1 rescans.
  if (url.pathname === "/repos") {
    const index = await repoIndex({ refresh: url.searchParams.get("refresh") === "1" }).catch((e) => ({ error: e.message }));
    return json(res, index);
  }

  // ── The keyring ──
  //
  // GET returns NAMES, notes and four-character hints. There is deliberately no
  // route on this server, at any origin, with any token, that returns a secret
  // VALUE — see keyring.mjs. That asymmetry is what makes it safe to POST one
  // from a phone: writing a key from the sofa is useful, and a readback route
  // would put every key he owns one auth bug away from the open internet.
  if (url.pathname === "/secrets") {
    if (req.method === "GET") return json(res, { secrets: await keyring.list() });
    if (req.method === "POST") {
      const b = await readBody(req);
      if (b.delete) {
        const gone = await keyring.remove(b.delete);
        return json(res, { ok: gone, deleted: gone ? String(b.delete).toUpperCase() : null });
      }
      try {
        const r = await keyring.put(b.name, b.value, { note: b.note });
        return json(res, { ok: true, ...r });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    }
    return json(res, { ok: false, error: "method_not_allowed" }, 405);
  }

  // ── Conversations ──
  // The thread lives here now rather than in a browser tab, which is what makes
  // it survive the tab closing, reachable from the phone, and readable by any
  // agent. See conversations.mjs.
  if (url.pathname === "/conversations" && req.method === "GET") {
    return json(res, {
      conversations: await convos.list({
        agent: url.searchParams.get("agent") || null,
        limit: Number(url.searchParams.get("limit")) || 40,
      }).catch(() => []),
    });
  }
  if (url.pathname === "/conversations" && req.method === "POST") {
    const b = await readBody(req);
    return json(res, await convos.create({ agent: b.agent || "cleetus" }));
  }
  // Clear = off the rail, still on disk, still searchable. Grayson wanted the
  // box emptied AND the conversation remembered, which is one flag rather than
  // a contradiction — see conversations.clear.
  if (url.pathname.endsWith("/clear") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.slice("/conversations/".length, -"/clear".length));
    const c = await convos.clear(id, true);
    if (!c) return json(res, { ok: false, error: "no_such_conversation" }, 404);
    return json(res, { ok: true, id: c.id, cleared: true });
  }
  if (url.pathname.startsWith("/conversations/")) {
    const id = decodeURIComponent(url.pathname.slice("/conversations/".length));
    if (req.method === "DELETE") return json(res, { ok: await convos.remove(id) });
    const c = await convos.load(id);
    if (!c) return json(res, { ok: false, error: "no_such_conversation" }, 404);
    return json(res, c);
  }

  // Streamed chat. The point is watching him touch the disk: every tool call
  // is pushed the moment it happens, rather than the whole thing arriving as
  // one silent block after twenty seconds.
  if (url.pathname === "/chat/stream" && req.method === "POST") {
    const body = await readBody(req);

    // ── Where the conversation comes from ──
    //
    // It used to come from the browser: `const HISTORY = []` in reach.html,
    // sliced to the last twelve turns and posted with every message. Closing
    // the tab lost it, the phone never had it, and turn thirteen dropped the
    // beginning silently.
    //
    // Now the caller sends an ID and the thread is read off the disk. The
    // `messages` form still works — the deck, bin/ask.mjs and anything else
    // that predates this all use it — but a caller that sends `conversation`
    // gets persistence, and that is the only difference between them.
    let convo = null;
    let history;
    if (body.conversation) {
      convo = await convos.open(body.conversation, { agent: body.agent || "cleetus", probe: body.probe === true });
      const incoming = Array.isArray(body.messages) && body.messages.length
        ? body.messages.filter((m) => m.role === "user").slice(-1)
        : body.message ? [{ role: "user", content: body.message }] : [];
      if (!incoming.length && !convo.messages.length) {
        return json(res, { ok: false, error: "no message" }, 400);
      }
      if (incoming.length) convo = await convos.append(convo.id, incoming);
      history = convos.replay(convo);
    } else {
      history = Array.isArray(body.messages) && body.messages.length
        ? body.messages
        : body.message ? [{ role: "user", content: String(body.message) }] : null;
    }
    if (!history || !history.length) return json(res, { ok: false, error: "no message" }, 400);

    // A picture with no eyes to see it is a different answer, not a worse one.
    // Said before the stream opens so the caller can go somewhere that CAN
    // see — the deck falls straight through to the cloud on this.
    if (hasImages(history) && !(await visionReady())) {
      return json(res, {
        ok: false, error: "no_vision",
        detail: `${CONFIG.visionModel} is not pulled on this machine, so the local model cannot ` +
                "look at an image.",
      });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Cloudflare, Caddy and every other proxy in the path will buffer a
      // response body unless told not to, which turns a stream into one silent
      // block delivered at the end — the exact thing this route exists to avoid.
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    // Writes go through this rather than res.write directly.
    //
    // Once the browser has gone, every write on the dead socket throws, and a
    // throw here escapes an async handler as an unhandled rejection — which is
    // fatal to the process by default and took the daemon down with every
    // unrelated conversation in flight. A closed socket is an ordinary event:
    // note it and stop writing.
    let gone = false;
    req.on("close", () => { gone = true; });
    const send = (o) => {
      if (gone) return false;
      try { return res.write(`data: ${JSON.stringify(o)}\n\n`); }
      catch { gone = true; return false; }
    };

    // ── The heartbeat, which is what "lost the connection" was really about ──
    //
    // A tool loop can spend two minutes between events: twenty steps, several
    // of them a shell command or a ripgrep across the disk. Nothing was written
    // to the socket in all that time, and an idle HTTP response is exactly what
    // every intermediary in the path is entitled to reap — the browser's own
    // timeout, Cloudflare's 100s idle limit, a laptop suspending its NIC. The
    // page then reported "lost the connection to cleetusd: network error",
    // which named the symptom and pointed at the wrong machine: cleetusd was
    // fine and still working, and the answer it eventually produced went
    // nowhere.
    //
    // A comment line every ten seconds costs nothing and resets every one of
    // those timers. SSE defines lines beginning with a colon as comments, so
    // this is invisible to the client parser.
    const beat = setInterval(() => {
      if (gone) return clearInterval(beat);
      try { res.write(`: still working\n\n`); } catch { gone = true; clearInterval(beat); }
    }, 10_000);

    try {
      const out = await ask({
        history,
        agent: body.agent,
        // Callers testing the system mark themselves, so their traffic is not
        // read back later as something Grayson asked for.
        probe: body.probe === true,
        onStep: ({ tool, args }) => {
          // One readable line per call. The full arguments go in the run file;
          // this is the bit a human can follow at a glance.
          const detail = args?.path || args?.command || args?.query || args?.note || args?.name || "";
          send({ type: "step", tool, detail: String(detail).slice(0, 90) });
        },
      });
      // Persisted BEFORE it is sent. If the socket has already gone the answer
      // is still in the thread, so reopening the conversation finds the reply
      // to the question that appeared to fail — which is the whole reason the
      // thread lives on disk rather than in the tab.
      if (convo) {
        await convos.append(convo.id, [{ role: "assistant", content: out.answer || "", agent: out.agent }])
          .catch(() => {});
      }
      send({ type: "agent", agent: out.agent });
      send({ type: "done", answer: out.answer, agent: out.agent, used: out.used,
             failed: out.failed, conversation: convo?.id || null });
    } catch (e) {
      console.error("[cleetusd] chat failed:", e?.stack || e);
      send({ type: "error", error: e.message });
    } finally {
      clearInterval(beat);
    }
    if (!gone) res.end();
    return;
  }

  if (url.pathname === "/chat" && req.method === "POST") {
    const body = await readBody(req);
    // Same two shapes as /chat/stream, for the same reason: this is the route
    // the tunnel uses, so a phone must get the persisted thread too.
    let convo = null;
    let history;
    if (body.conversation) {
      convo = await convos.open(body.conversation, { agent: body.agent || "cleetus", probe: body.probe === true });
      const incoming = Array.isArray(body.messages) && body.messages.length
        ? body.messages.filter((m) => m.role === "user").slice(-1)
        : body.message ? [{ role: "user", content: body.message }] : [];
      if (incoming.length) convo = await convos.append(convo.id, incoming);
      history = convos.replay(convo);
    } else {
      history = Array.isArray(body.messages) && body.messages.length
        ? body.messages
        : body.message
          ? [{ role: "user", content: String(body.message) }]
          : null;
    }
    if (!history || !history.length) return json(res, { ok: false, error: "no message" }, 400);
    if (hasImages(history) && !(await visionReady())) {
      return json(res, {
        ok: false, error: "no_vision",
        detail: `${CONFIG.visionModel} is not pulled on this machine, so the local model cannot ` +
                "look at an image.",
      });
    }

    try {
      const out = await ask({ history, agent: body.agent, probe: body.probe === true });
      if (convo) {
        await convos.append(convo.id, [{ role: "assistant", content: out.answer || "", agent: out.agent }])
          .catch(() => {});
      }
      return json(res, { ok: true, ...out, conversation: convo?.id || null });
    } catch (e) {
      // Logged, like /chat/stream already does. This route is the one the
      // tunnel uses — every message from the phone comes through here — and it
      // was the only failure path in the daemon that wrote nothing anywhere. So
      // a request that died here left a thread holding a question with no
      // answer under it and not one line in cleetusd.err.log to say why, which
      // is a bad way to find out anything.
      console.error("[cleetusd] chat failed:", e?.stack || e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (url.pathname === "/route" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, { agent: await route(body.message || "") });
  }

  return json(res, { ok: false, error: "not found" }, 404);
}

/* ── The daemon does not get to exit because one request went wrong ───────────
 *
 * Node's default for an unhandled rejection is to print it and exit(1). That is
 * right for a script and wrong for a process somebody is mid-conversation with:
 * cleetusd.err.log is a wall of identical ERR_HTTP_HEADERS_SENT stacks, each
 * one a restart, each restart killing every unrelated request in flight. The
 * MJPEG proxy raising after its headers were sent did it repeatedly, and it is
 * the same class of fault as a write to a socket the browser already closed.
 *
 * Every one of those is now individually handled at its own call site. This is
 * the backstop for the one nobody has thought of yet, and it is deliberately
 * LOUD — the log line is the thing that gets it fixed properly, and swallowing
 * it silently would trade a visible crash for an invisible corruption.
 *
 * Not caught here: a genuine startup failure. Those happen before listen() and
 * should still take the process down, because launchd restarting it is the
 * correct response to a daemon that cannot start.
 */
let listening = false;
process.on("unhandledRejection", (e) => {
  console.error("[cleetusd] unhandled rejection (staying up):", e?.stack || e);
  if (!listening) process.exit(1);
});
process.on("uncaughtException", (e) => {
  console.error("[cleetusd] uncaught exception (staying up):", e?.stack || e);
  if (!listening) process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  listening = true;
  console.log(`cleetusd on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  model  ${CONFIG.model}`);
  console.log(`  vault  ${CONFIG.vault}`);
  console.log(`  shell  ${CONFIG.shellEnabled ? "enabled" : "OFF"}`);
  console.log(`  auth   ${CONFIG.token ? "bearer required" : "NONE (loopback only)"}`);
});
