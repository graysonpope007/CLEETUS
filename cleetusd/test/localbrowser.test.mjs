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
//
// It used to hold its own COPY of the rule, kept honest by a check that the
// same source still appeared in server.mjs — necessary only because server.mjs
// starts listening on import and so could not be imported here. The rule now
// lives in gate.mjs, which imports cleanly, so the copy and the drift check are
// both gone: this exercises the real function. A test of a copy passes happily
// while the original rots.
import { isLocalBrowser } from "../src/gate.mjs";

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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
