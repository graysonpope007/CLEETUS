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
import { ask, route } from "./agent.mjs";
import { agentList } from "./agents.mjs";
import { health as ollamaHealth, visionReady } from "./ollama.mjs";
import { loadSkills, recentRuns } from "./memory.mjs";
import { DASHBOARD } from "./ui.mjs";
import { vaultReachable } from "./tools/index.mjs";
import { accessReport } from "./access.mjs";
import { litraRaw } from "./tools/devices.mjs";
import { runDoctor } from "./doctor.mjs";

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

// Only enforced when a token is configured. On loopback with no token set this
// is a dev convenience; the moment it is exposed, CLEETUSD_TOKEN is what stands
// between a stranger and `run_shell`.
function authed(req) {
  if (!CONFIG.token) return true;
  const h = req.headers.authorization || "";
  return h === `Bearer ${CONFIG.token}`;
}

/**
 * A browser sitting at this Mac, as opposed to a request that arrived through
 * a proxy.
 *
 * A plain loopback check is NOT enough on its own and the reason is the whole
 * point: if this port is ever put behind the cloudflared tunnel, cloudflared
 * connects to 127.0.0.1 too, so every remote request would look local. What
 * distinguishes them is that a proxy adds forwarding headers. Absence of those
 * plus a loopback peer means the request really did originate on this machine.
 *
 * This exists because a browser cannot attach an Authorization header to a
 * top-level navigation, so the dashboard could never be opened otherwise. The
 * bearer still guards everything that arrives any other way.
 */
function isLocalBrowser(req) {
  const peer = req.socket?.remoteAddress || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const proxied =
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-proto"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["cf-connecting-ip"];
  return loopback && !proxied;
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
                          "/light", "/doctor"];
  const localBrowser = isLocalBrowser(req) && BROWSER_ROUTES.includes(url.pathname);

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
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
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

  if (url.pathname === "/skills") {
    const skills = await loadSkills().catch(() => []);
    return json(res, { skills: skills.map((s) => ({ title: s.title, when: s.when, file: s.file })) });
  }

  if (url.pathname === "/runs") {
    return json(res, { runs: await recentRuns().catch(() => []) });
  }

  // Streamed chat. The point is watching him touch the disk: every tool call
  // is pushed the moment it happens, rather than the whole thing arriving as
  // one silent block after twenty seconds.
  if (url.pathname === "/chat/stream" && req.method === "POST") {
    const body = await readBody(req);
    const history = Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : body.message ? [{ role: "user", content: String(body.message) }] : null;
    if (!history) return json(res, { ok: false, error: "no message" }, 400);

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
      "Access-Control-Allow-Origin": "*",
    });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    try {
      const out = await ask({
        history,
        agent: body.agent,
        onStep: ({ tool, args }) => {
          // One readable line per call. The full arguments go in the run file;
          // this is the bit a human can follow at a glance.
          const detail = args?.path || args?.command || args?.query || args?.note || args?.name || "";
          send({ type: "step", tool, detail: String(detail).slice(0, 90) });
        },
      });
      send({ type: "agent", agent: out.agent });
      send({ type: "done", answer: out.answer, agent: out.agent, used: out.used, failed: out.failed });
    } catch (e) {
      send({ type: "error", error: e.message });
    }
    return res.end();
  }

  if (url.pathname === "/chat" && req.method === "POST") {
    const body = await readBody(req);
    const history = Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : body.message
        ? [{ role: "user", content: String(body.message) }]
        : null;
    if (!history) return json(res, { ok: false, error: "no message" }, 400);
    if (hasImages(history) && !(await visionReady())) {
      return json(res, {
        ok: false, error: "no_vision",
        detail: `${CONFIG.visionModel} is not pulled on this machine, so the local model cannot ` +
                "look at an image.",
      });
    }

    try {
      const out = await ask({ history, agent: body.agent });
      return json(res, { ok: true, ...out });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (url.pathname === "/route" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, { agent: await route(body.message || "") });
  }

  return json(res, { ok: false, error: "not found" }, 404);
}

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`cleetusd on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  model  ${CONFIG.model}`);
  console.log(`  vault  ${CONFIG.vault}`);
  console.log(`  shell  ${CONFIG.shellEnabled ? "enabled" : "OFF"}`);
  console.log(`  auth   ${CONFIG.token ? "bearer required" : "NONE (loopback only)"}`);
});
