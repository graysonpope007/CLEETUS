// devices-dash: serves the panel page and proxies /devices to cleetusd.
//
// THE SERVICE HOLDS THE BEARER, THE PAGE NEVER DOES -- same rule as ruview-dash.
// The token is read from /opt/protocol-pi/secrets/ruview.token (the CLEETUSD_TOKEN),
// so it never reaches the browser or the kiosk's page source.
//
// CORS matters here even though it looks like it should not: the PROTOCOL scene
// page on :8080 probes this service on :8791, which is cross-origin. Omitting the
// header made ruview-dash display "NOT RUNNING" while it was serving perfectly,
// and systemctl said active the whole time. Do not remove this header.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8791);
// THE WIRED LINK FIRST, THE TUNNEL SECOND. The Pi hangs off the Mac's
// Internet Sharing port (192.168.2.2 -> 192.168.2.1, 0.6 ms) and cleetusd
// listens on that address with the bearer required. Measured from here:
// /controls is 2-200 ms direct and 5.4 s through me.cleetusai.com. The tunnel
// stays as the fallback for when the Mac's bridge interface is down, so the
// panel gets slower rather than blank.
const UPSTREAMS = (process.env.CLEETUSD_URL || "http://192.168.2.1:8767,https://me.cleetusai.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
let UPSTREAM = UPSTREAMS[0];
// The upstream that answers last is tried first next time, so one dead link
// does not cost a connect timeout on every poll.
async function upstreamFetch(path, init) {
  let lastErr;
  for (const base of UPSTREAMS) {          // fixed order: wired link first, tunnel fallback
    try {
      const r = await fetch(`${base}${path}`, init);
      UPSTREAM = base;
      return r;
    } catch (e) {
      lastErr = e;
      console.error(`upstream ${base} failed: ${e.message}`);
    }
  }
  throw lastErr;
}
const TOKEN_FILE = process.env.TOKEN_FILE || "/opt/protocol-pi/secrets/ruview.token";

let token = "";
try { token = (await readFile(TOKEN_FILE, "utf8")).trim(); }
catch { console.error(`no token at ${TOKEN_FILE} -- /devices will 502`); }

http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const path = (req.url || "/").split("?")[0];

  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, has_token: Boolean(token), upstream: UPSTREAM }));
  }

  // Control surface: read the list, and post a tap. Both carry the bearer that
  // lives in this service and never in the page.
  if (path === "/controls" || path === "/controls/set") {
    try {
      const isPost = req.method === "POST";
      let body;
      if (isPost) {
        body = await new Promise((resolve, reject) => {
          let b = ""; req.on("data", (d) => (b += d));
          req.on("end", () => resolve(b)); req.on("error", reject);
        });
      }
      const r = await upstreamFetch(path, {
        method: isPost ? "POST" : "GET",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(isPost ? { "content-type": "application/json" } : {}),
        },
        body: isPost ? body : undefined,
        // A Meross write is one cloud round trip via merossd (~0.8 s with
        // readback); the long ceiling is for the cold ctl.py fallback path.
        signal: AbortSignal.timeout(isPost ? 40_000 : 12_000),
      });
      const text = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(text);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  if (path === "/devices") {
    try {
      const r = await upstreamFetch("/devices", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(8_000),
      });
      const body = await r.text();
      // Pass the upstream status through. Swallowing it into a 200 would let the
      // page believe a failure was data, which is the one thing the panel must
      // never do -- it would show yesterday's outlet states as current.
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(body);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  try {
    const html = await readFile(join(HERE, "public", "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500); res.end(String(e.message || e));
  }
}).listen(PORT, () => console.log(`devices-dash on :${PORT} -> ${UPSTREAMS.join(" then ")}`));
