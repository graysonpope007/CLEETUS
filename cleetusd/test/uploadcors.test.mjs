// test/uploadcors.test.mjs — the header the page sends is a header the gate names.
//
// /reach is one file served from two places, and only one of them is same-origin
// with this daemon. Opened at 127.0.0.1:8767/reach it talks to a relative path
// and no CORS rule applies at all. Opened at cleetusai.com it probes loopback,
// finds this daemon, and talks to http://127.0.0.1:8767 — a different origin, so
// every upload is preflighted first.
//
// X-Drop-Name is a custom header, which is the thing that makes an upload
// preflight rather than simply go. It was not named in the preflight's
// Access-Control-Allow-Headers, so Chrome refused to send the real request and
// fetch reported that refusal as `TypeError: Failed to fetch` — the identical
// words it uses for a daemon that is not running. Every drop from the site
// failed, while curl passed, the deck passed, and /health passed, because none
// of those crosses an origin. Measured, both ways, in a real headless Chrome:
// the same POST minus that one header succeeded and arrived named "file".
//
// So this does not test CORS. It tests the only thing that went wrong: the list
// of headers the pages SEND and the list this daemon ALLOWS, kept level. Adding
// a header to either page without adding it here fails from that day.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SERVER = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

// The gate's own list, read from the source rather than restated here — a copy
// of the answer in the test file passes forever while the real one rots.
const allowed = (SERVER.match(/const ALLOWED_HEADERS = "([^"]+)"/) || [])[1];

// Every custom header any page hands fetch. Bare `X-Whatever':` in a headers
// object; the safelisted ones (Content-Type) need no permission and are not the
// failure mode.
const sentBy = (src) =>
  [...src.matchAll(/["']([Xx]-[A-Za-z][A-Za-z0-9-]*)["']\s*:/g)].map((m) => m[1].toLowerCase());

const PAGES = [
  ["the deck", new URL("../src/ui.mjs", import.meta.url).pathname],
  ["/reach", join(homedir(), "cleetusv2", "reach.html")],
];

test("the gate names its allowed headers once, in one place", () => {
  assert.ok(allowed, "ALLOWED_HEADERS has gone missing from server.mjs");
  // Was a hardcoded 2 — the preflight and json(). A third writer arrived (the
  // /ruview passthrough, which streams the sensing server's own body and so
  // cannot go through json()), and a count is the wrong thing to assert anyway:
  // it fails on a correct new route and passes on a wrong one that keeps the
  // total the same. What actually matters is that EVERY site answering this
  // header answers from the constant, which is now what is checked.
  const sites = SERVER.match(/"Access-Control-Allow-Headers":/g)?.length ?? 0;
  const fromConst = SERVER.match(/"Access-Control-Allow-Headers":\s*ALLOWED_HEADERS/g)?.length ?? 0;
  assert.ok(sites >= 2, "the preflight and json() must both still answer this header");
  assert.strictEqual(fromConst, sites,
    `${sites - fromConst} place(s) answer Access-Control-Allow-Headers without using ALLOWED_HEADERS — ` +
    "they drift apart again, which is exactly how X-Drop-Name was lost");
  assert.ok(
    !/"Access-Control-Allow-Headers":\s*"/.test(SERVER),
    "a literal header list has come back; that is exactly how X-Drop-Name was lost",
  );
});

test("every custom header the pages send is one the preflight admits", () => {
  const list = allowed.split(",").map((h) => h.trim().toLowerCase());
  let checked = 0;
  for (const [what, file] of PAGES) {
    // /reach lives in the site repo. Absent, there is nothing to check and
    // nothing to fail — but the deck is in this one and must always be there.
    if (!existsSync(file)) {
      assert.notStrictEqual(what, "the deck", "src/ui.mjs is missing");
      continue;
    }
    for (const h of new Set(sentBy(readFileSync(file, "utf8")))) {
      checked++;
      assert.ok(list.includes(h),
        `${what} sends ${h} and the preflight does not allow it — from cleetusai.com ` +
        "that reads as \"Failed to fetch\", with the daemon perfectly healthy");
    }
  }
  assert.ok(checked > 0, "no page header was found at all; the matcher has stopped matching");
});

test("the header the whole drop depends on is named", () => {
  // Not merely one of the list: without this the bytes still arrive, so the
  // upload looks fine, and every file is called "file".
  assert.ok(allowed.toLowerCase().includes("x-drop-name"));
});

// ── The belt ────────────────────────────────────────────────────────────────
// A header list is a thing one commit can undo, and the browser rules around a
// public page touching a loopback address are not ours to hold still. So /reach
// tries the tunnel when the direct hop dies at the browser: same daemon, no
// preflight, because it is same-origin with the page. This runs the SHIPPED
// function against fake routes rather than a paraphrase of it.
const REACH = join(homedir(), "cleetusv2", "reach.html");

const routeRun = (opts) => {
  const src = readFileSync(REACH, "utf8");
  const body = src.slice(src.indexOf("async function upload(file, rel) {"),
                         src.indexOf("/* Upload a batch,"));
  const prelude = `
    const base = ${JSON.stringify(opts.base)};
    const SAME_ORIGIN_DAEMON = ${!!opts.same};
    const tried = [];
    const whyUnreadable = async () => null;
    const fetch = async (url) => {
      tried.push(url);
      if (${JSON.stringify(opts.dead)}.includes(url)) throw new TypeError('Failed to fetch');
      return { status: 200, json: async () => ({ ok: true, via: url }) };
    };`;
  const { upload, tried } = new Function(prelude + body + "\nreturn { upload, tried };")();
  return upload({ type: "image/png" }, "p.png").then(
    (d) => ({ via: d.via, tried }), (e) => ({ error: e.message, tried }));
};

test("a drop from the site survives the direct hop being refused", { skip: !existsSync(REACH) },
  async () => {
    const r = await routeRun({ base: "http://127.0.0.1:8767", dead: ["http://127.0.0.1:8767/upload"] });
    assert.strictEqual(r.via, "/api/reach/upload",
      "the loopback POST died and the file went nowhere; the tunnel was right there");
  });

test("the direct hop is still preferred when it works", { skip: !existsSync(REACH) }, async () => {
  const r = await routeRun({ base: "http://127.0.0.1:8767", dead: [] });
  assert.deepStrictEqual(r.tried, ["http://127.0.0.1:8767/upload"],
    "a working local hop must not be paying for a round trip through Cloudflare");
});

test("the page cleetusd serves itself never invents a tunnel", { skip: !existsSync(REACH) },
  async () => {
    // /api/reach does not exist on 127.0.0.1:8767. Asking it there answers 401
    // in plain text, which parses as nothing and reads as a stranger error than
    // the true one: the daemon is down.
    const r = await routeRun({ base: "", same: true, dead: ["/upload"] });
    assert.ok(!r.tried.some((u) => u.startsWith("/api/reach")), r.tried.join(","));
    assert.match(r.error, /could not reach Cleetus/);
  });
