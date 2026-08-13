// src/flights.mjs — where the aircraft actually come from.
//
// WHY THIS MOVED TO THE MAC
// The map showed five clusters and claimed to be the world. The code was not
// wrong; the ADDRESS was. Both free aggregators rate-limit by IP, and every
// anchor was being fetched from Cloudflare's egress — one hot, shared address
// that a lot of other people are also hammering.
//
// Measured, same code, same minute:
//   from Cloudflare   5/20 anchors,  2,869 aircraft
//   from this Mac    20/20 anchors,  7,726 aircraft
//
// This is the second time this project has hit exactly this: OpenSky returned
// 6,618 vectors to a laptop and nothing to the edge. The lesson is not "pick a
// better aggregator", it is that a free IP-rate-limited feed cannot be called
// from a datacentre. Grayson's house has a residential IP and now runs a
// daemon, so the poll happens here and the result is pushed up.
//
// AVIATION EDGE
// If AVIATION_EDGE_KEY is set, that is used instead: one call, global, no
// anchors, no rate-limit games. It is a paid subscription with no free tier,
// which is the only reason it is not the default. Note this is NOT aviationstack
// — that one serves SCHEDULES on its free tier, which is how the deck once
// showed "10,000 in air, 0 plotted".

import { secrets } from "./config.mjs";

export const ANCHORS = [
  [33.47, -82.01, "Augusta"], [40.7, -74.0, "New York"], [41.9, -87.6, "Chicago"],
  [32.9, -97.0, "Dallas"], [34.0, -118.2, "Los Angeles"], [47.6, -122.3, "Seattle"],
  [25.8, -80.3, "Miami"], [51.5, -0.1, "London"], [50.1, 8.7, "Frankfurt"],
  [40.4, -3.7, "Madrid"], [55.8, 37.6, "Moscow"], [25.3, 55.4, "Dubai"],
  [28.6, 77.2, "Delhi"], [35.7, 139.8, "Tokyo"], [1.36, 103.99, "Singapore"],
  [-33.9, 151.2, "Sydney"], [-23.5, -46.6, "Sao Paulo"], [-26.1, 28.2, "Johannesburg"],
  [19.4, -99.1, "Mexico City"], [43.7, -79.4, "Toronto"],
];

// Order matters: first one with actual aircraft wins.
//
// adsb.fi is first because it is the only one of the three still serving data.
// The other two are kept, not deleted — feeds come back, and a source that is
// dead today costs one failed request to check.
const SOURCES = [
  ["adsb.fi", (la, lo) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/250`],
  ["adsb.lol", (la, lo) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/250`],
  ["airplanes.live", (la, lo) => `https://api.airplanes.live/v2/point/${la}/${lo}/250`],
];

function normalise(list) {
  const out = [];
  for (const a of list) {
    if (!a || typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    if (a.alt_baro === "ground") continue; // parked aircraft are not "in the air"
    out.push({
      id: a.hex,
      call: (a.flight || "").trim() || null,
      // 3dp is ~110m. Full float precision triples the payload to describe a
      // position that moves further than the extra digits in the time it takes
      // to render.
      lat: Math.round(a.lat * 1000) / 1000,
      lon: Math.round(a.lon * 1000) / 1000,
      altM: typeof a.alt_baro === "number" ? Math.round(a.alt_baro * 0.3048) : null,
      velMs: typeof a.gs === "number" ? Math.round(a.gs * 0.514444) : null,
      track: typeof a.track === "number" ? Math.round(a.track) : null,
    });
  }
  return out;
}

async function anchor(la, lo) {
  // AN EMPTY ANSWER IS NOT AN ANSWER.
  //
  // This used to return on the first source that produced an Array — and
  // `[]` is an Array. adsb.lol answers HTTP 200, `"msg": "No error"`, `"total":
  // 0`, an empty list, for every anchor on earth. Perfectly well-formed, and
  // completely empty. So the loop returned success on the first source, the
  // fallbacks were never reached, and the whole map went dark while every
  // component reported that it was fine: the sweeper "succeeded", the ingest
  // correctly refused an empty sweep, and the endpoint said
  // `no_adsb_feed_reachable` — which was true, and named none of this.
  //
  // So: keep going until something actually has aircraft in it. Zero aircraft
  // over Atlanta at midday is not data, it is a dead feed being polite.
  let answered = null;
  for (const [name, url] of SOURCES) {
    try {
      const r = await fetch(url(la, lo), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue; // 429 and 403 are normal here; the fallback carries it
      const j = await r.json();
      const ac = j.ac || j.aircraft || [];
      if (!Array.isArray(ac)) continue;
      const aircraft = normalise(ac);
      if (aircraft.length) return { source: name, aircraft };
      // Remember that someone was reachable, and try the next one anyway.
      answered ||= name;
    } catch { /* next source */ }
  }
  // Genuinely empty sky is possible — mid-Pacific at 3am. Say who told us so,
  // rather than reporting it the same way as nobody answering at all.
  return { source: answered, aircraft: [] };
}

/** One paid call, whole planet, no anchors. */
async function viaAviationEdge(key) {
  const r = await fetch(`https://aviation-edge.com/v2/public/flights?key=${encodeURIComponent(key)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`aviation-edge ${r.status}`);
  const j = await r.json();
  // The API answers errors with a 200 and an object, not an array.
  if (!Array.isArray(j)) throw new Error(`aviation-edge: ${JSON.stringify(j).slice(0, 200)}`);
  const out = [];
  for (const f of j) {
    const g = f.geography || {};
    if (typeof g.latitude !== "number" || typeof g.longitude !== "number") continue;
    if (f.status && f.status !== "en-route") continue;
    out.push({
      id: (f.aircraft?.icao24 || f.flight?.icaoNumber || "").toLowerCase() || null,
      call: f.flight?.icaoNumber || f.flight?.iataNumber || null,
      lat: Math.round(g.latitude * 1000) / 1000,
      lon: Math.round(g.longitude * 1000) / 1000,
      altM: typeof g.altitude === "number" ? Math.round(g.altitude) : null,
      velMs: typeof f.speed?.horizontal === "number" ? Math.round(f.speed.horizontal / 3.6) : null,
      track: typeof g.direction === "number" ? Math.round(g.direction) : null,
    });
  }
  return { aircraft: out, anchorsAnswered: 1, anchorsTried: 1, source: "aviation-edge" };
}

/**
 * A full sweep. Sequential on purpose: twenty parallel requests get most of
 * adsb.lol's answers replaced by 429s, and the whole run only takes ~15s
 * anyway. Slower and complete beats fast and five-sixths empty.
 */
export async function sweep({ onProgress } = {}) {
  const key = secrets.AVIATION_EDGE_KEY;
  if (key && key !== "REPLACE_ME") {
    try { return await viaAviationEdge(key); } catch (e) {
      onProgress?.({ name: "aviation-edge", error: e.message });
      // fall through to the free path rather than showing an empty map
    }
  }

  const seen = new Map();
  let answered = 0;
  for (const [la, lo, name] of ANCHORS) {
    const { source, aircraft } = await anchor(la, lo);
    if (source) answered++;
    // Anchors overlap heavily — 250nm circles around Augusta and Miami share a
    // lot of sky. Dedupe by ICAO hex or the last one written wins twice.
    for (const a of aircraft) if (a.id) seen.set(a.id, a);
    onProgress?.({ name, source, got: aircraft.length, total: seen.size });
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    aircraft: [...seen.values()],
    anchorsAnswered: answered,
    anchorsTried: ANCHORS.length,
    source: "adsb",
  };
}
