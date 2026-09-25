// devices-dash: serves the Pi's main panel (clock, room controls, RuView, markets)
// and proxies /controls to cleetusd, /ruview to ruview-dash, /quotes to Yahoo.
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

const RUVIEW_URL = process.env.RUVIEW_URL || "http://127.0.0.1:8790/api/state";

// ── Quotes ──────────────────────────────────────────────────────────────────
// SPY / NVDA / AAPL from Yahoo's keyless chart API. Fetched on demand with a
// TTL (30 s while the market is open, 5 min otherwise) and ONE refresh in
// flight at a time -- ruview-dash leaked the Pi to death by letting pollers
// stack, so nothing here starts a fetch while one is running. The last good
// set is kept and served with its age; a failure never blanks the prices.
const SYMBOLS = (process.env.QUOTE_SYMBOLS || "SPY,NVDA,AAPL").split(",").map((s) => s.trim()).filter(Boolean);
let quoteCache = { at: 0, symbols: [], error: null, open: false };
let quoteInflight = null;

async function fetchQuote(sym) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`,
    // 15 s, not 8: every DNS lookup on the Pi costs a flat 5 s (a first-resolver
    // timeout in /etc/resolv.conf, measured 22 Sep), before Yahoo even answers.
    { headers: { "user-agent": "Mozilla/5.0 (X11; Linux aarch64) cleetus-panel" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${sym} http ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error(`${sym} empty`);
  const m = res.meta;
  const closes = res.indicators?.quote?.[0]?.close || [];
  // Drop the nulls Yahoo emits for bars with no trades; keep order.
  const spark = closes.filter((v) => typeof v === "number").map((v) => +v.toFixed(2));
  const prev = m.chartPreviousClose ?? m.previousClose;
  const price = m.regularMarketPrice;
  const tp = m.currentTradingPeriod?.regular;
  const now = Date.now() / 1000;
  return {
    symbol: m.symbol, name: m.shortName || m.longName || m.symbol,
    price, prev,
    change: price != null && prev ? +(price - prev).toFixed(2) : null,
    changePct: price != null && prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
    high: m.regularMarketDayHigh ?? null, low: m.regularMarketDayLow ?? null,
    volume: m.regularMarketVolume ?? null,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    open: Boolean(tp && now >= tp.start && now < tp.end),
    spark,
  };
}

async function refreshQuotes() {
  const out = await Promise.allSettled(SYMBOLS.map(fetchQuote));
  const got = out.filter((o) => o.status === "fulfilled").map((o) => o.value);
  const errs = out.filter((o) => o.status === "rejected").map((o) => String(o.reason?.message || o.reason));
  if (got.length) {
    // Merge per symbol so one failed ticker keeps its last good row.
    const bySym = new Map(quoteCache.symbols.map((q) => [q.symbol, q]));
    for (const q of got) bySym.set(q.symbol, q);
    quoteCache = {
      at: Date.now(),
      symbols: SYMBOLS.map((s) => bySym.get(s)).filter(Boolean),
      error: errs.length ? errs.join("; ") : null,
      open: got.some((q) => q.open),
    };
  } else {
    quoteCache = { ...quoteCache, error: errs.join("; ") || "no quotes" };
  }
}

async function quotes() {
  const ttl = quoteCache.open ? 30_000 : 300_000;
  if (Date.now() - quoteCache.at > ttl && !quoteInflight) {
    quoteInflight = refreshQuotes().catch((e) => { quoteCache = { ...quoteCache, error: String(e.message || e) }; })
      .finally(() => { quoteInflight = null; });
  }
  // First call has nothing to show yet, so wait for it; after that, serve the
  // cache immediately and let the refresh land on the next poll.
  if (!quoteCache.at && quoteInflight) await quoteInflight;
  return quoteCache;
}

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

  if (["/appletv/state", "/appletv/catalog", "/appletv/command"].includes(path)) {
    const command = path === "/appletv/command";
    if (req.method !== (command ? "POST" : "GET")) { res.writeHead(405); return res.end(); }
    try {
      let body;
      if (command) {
        body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) { res.writeHead(413); return res.end(); }
        }
      }
      // Do not retry a remote button after an ambiguous network failure.
      // Read requests discover the healthy upstream before commands use it.
      const send = command ? (p, init) => fetch(`${UPSTREAM}${p}`, init) : upstreamFetch;
      const r = await send(path, {
        method: command ? "POST" : "GET",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(command ? { "content-type": "application/json" } : {}) },
        body, signal: AbortSignal.timeout(25000),
      });
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(await r.text());
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Apple TV connection unavailable. Check the Mac and Apple TV." }));
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

  // Markets strip. Yahoo's chart endpoint needs no key; it is fetched HERE, not
  // by the page, so the kiosk never talks to the internet directly and a slow
  // Yahoo costs one request per TTL no matter how many screens poll.
  if (path === "/quotes") {
    const q = await quotes();
    res.writeHead(q.symbols.length ? 200 : 502, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ...q, age_ms: q.at ? Date.now() - q.at : null }));
  }

  // RuView lives in ruview-dash on this same Pi (:8790). Proxied rather than
  // fetched cross-origin so the panel has one origin and one failure surface.
  // No new upstream poll: ruview-dash already polls the Mac; this reads its
  // snapshot from loopback.
  if (path === "/ruview") {
    try {
      const r = await fetch(RUVIEW_URL, { signal: AbortSignal.timeout(3_000) });
      const body = await r.text();
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(body);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  // Fonts are served locally: a wall panel must not go blank-typed because
  // Google Fonts was unreachable at boot. Name allowlist, no path joins.
  const font = path.match(/^\/fonts\/([A-Za-z]+-normal\.woff2)$/);
  if (font) {
    try {
      const buf = await readFile(join(HERE, "public", "fonts", font[1]));
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=604800" });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end(); }
  }

  // The previous panel, kept one URL away in case the new one misbehaves.
  const page = path === "/classic" ? "classic.html" : "index.html";
  try {
    const html = await readFile(join(HERE, "public", page), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500); res.end(String(e.message || e));
  }
}).listen(PORT, () => console.log(`devices-dash on :${PORT} -> ${UPSTREAMS.join(" then ")}`));
