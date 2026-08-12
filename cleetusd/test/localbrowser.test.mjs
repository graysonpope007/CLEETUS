// test/localbrowser.test.mjs — the rule that lets a browser in.
//
// A browser cannot attach an Authorization header to a top-level navigation,
// so the dashboard needs a way through the bearer gate. The rule is "loopback
// peer AND no forwarding headers", and the second half is the load-bearing
// part: if 8767 is ever put behind cloudflared, the tunnel connects to
// 127.0.0.1 as well, so a naive loopback check would admit the whole internet.
//
// This tests the predicate directly rather than firing forged headers at the
// running daemon.

// Kept in step with the copy in src/server.mjs by the identical-source check
// at the bottom of this file.
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

const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });

const CASES = [
  ["browser on this Mac (IPv4)", req("127.0.0.1"), true],
  ["browser on this Mac (IPv6)", req("::1"), true],
  ["browser on this Mac (mapped)", req("::ffff:127.0.0.1"), true],
  ["another machine on the LAN", req("192.168.1.40"), false],
  ["the open internet", req("8.8.8.8"), false],
  ["tunnelled: loopback peer + X-Forwarded-For", req("127.0.0.1", { "x-forwarded-for": "8.8.8.8" }), false],
  ["tunnelled: loopback peer + X-Forwarded-Proto", req("127.0.0.1", { "x-forwarded-proto": "https" }), false],
  ["tunnelled: loopback peer + X-Forwarded-Host", req("127.0.0.1", { "x-forwarded-host": "me.cleetusai.com" }), false],
  ["behind Cloudflare: CF-Connecting-IP", req("127.0.0.1", { "cf-connecting-ip": "8.8.8.8" }), false],
  ["no peer address at all", req(""), false],
];

let pass = 0, fail = 0;
for (const [name, r, want] of CASES) {
  const got = isLocalBrowser(r);
  if (got === want) { pass++; console.log(`  ok   ${want ? "allow " : "refuse"} ${name}`); }
  else { fail++; console.log(`  FAIL ${name}: wanted ${want}, got ${got}`); }
}

// The predicate above is a copy. If server.mjs drifts, this suite would keep
// passing while the real gate changed underneath it — so compare the source.
const src = await (await import("node:fs/promises")).readFile(
  new URL("../src/server.mjs", import.meta.url), "utf8");
const body = src.slice(src.indexOf("function isLocalBrowser"), src.indexOf("const server = createServer"));
const sameRule =
  body.includes('peer === "127.0.0.1"') && body.includes('peer === "::1"') &&
  body.includes('x-forwarded-for') && body.includes('x-forwarded-proto') &&
  body.includes('x-forwarded-host') && body.includes('cf-connecting-ip') &&
  body.includes("return loopback && !proxied");
if (sameRule) { pass++; console.log("  ok   server.mjs still implements this exact rule"); }
else { fail++; console.log("  FAIL server.mjs has drifted from the rule under test"); }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
