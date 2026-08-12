#!/usr/bin/env node
// bin/flights-push.mjs — sweep from the house, push the result to the app.
//
//   node bin/flights-push.mjs           one sweep, push, exit
//   node bin/flights-push.mjs --loop    keep sweeping every 90s
//   node bin/flights-push.mjs --dry     sweep and report, push nothing
//
// Push, not pull, on purpose: a pull would need an inbound tunnel to this Mac,
// which means a sudo config edit and a public hostname. This needs neither. If
// the Mac is asleep the snapshot goes stale and /api/flights says so and falls
// back to its own fan-out, which is degraded but not broken.

import { createHmac } from "node:crypto";
import { sweep } from "../src/flights.mjs";
import { CONFIG, secrets } from "../src/config.mjs";

const loop = process.argv.includes("--loop");
const dry = process.argv.includes("--dry");

// Same derivation as functions/_lib/guard.js internalToken().
function internalToken() {
  const s = secrets.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET missing from cleetus.env");
  return createHmac("sha256", s).update("cleetus-internal-subrequest-v1").digest("hex");
}

async function once() {
  const t0 = Date.now();
  const res = await sweep({
    onProgress: ({ name, source, got, total, error }) =>
      process.stderr.write(
        error ? `  ${name}: ${error}\n` : `  ${String(name).padEnd(13)} ${(source || "no answer").padEnd(15)} ${String(got).padStart(5)}  total ${total}\n`,
      ),
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\n${res.aircraft.length} aircraft, ${res.anchorsAnswered}/${res.anchorsTried} anchors, ${res.source}, ${secs}s`);

  if (dry) return;

  const r = await fetch(`${CONFIG.cloud}/api/flights-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cleetus-Internal": internalToken() },
    body: JSON.stringify({
      aircraft: res.aircraft,
      anchors_answered: res.anchorsAnswered,
      anchors: res.anchorsTried,
      source: res.source,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  console.error(`push: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

if (loop) {
  for (;;) {
    try { await once(); } catch (e) { console.error(`sweep failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 90_000));
  }
} else {
  await once();
}
