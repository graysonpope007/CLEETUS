// test/gate.test.mjs — the code that decides whether a stranger reaches run_shell.
//
// This daemon holds an unrestricted shell, the filesystem, and a keyring of real
// credentials, on a port published through a cloudflared tunnel. The gate was
// previously untestable because server.mjs listens the moment it is imported,
// so the single most security-critical function in the system was the one with
// no tests. It now lives in gate.mjs for that reason alone.
//
// Note these import the real functions. An earlier test of the loopback rule
// reimplemented it inside the test file, which tests a copy and passes happily
// while the real one rots.

import { test } from "node:test";
import assert from "node:assert";
import { authed, isLocalBrowser } from "../src/gate.mjs";

const TOKEN = "s3cret";
const req = (headers = {}, peer = "127.0.0.1") => ({ headers, socket: { remoteAddress: peer } });

test("with a token set, only the right bearer gets in", () => {
  assert.strictEqual(authed(req({ authorization: `Bearer ${TOKEN}` }), TOKEN), true);
  assert.strictEqual(authed(req({ authorization: "Bearer wrong" }), TOKEN), false);
  assert.strictEqual(authed(req({ authorization: TOKEN }), TOKEN), false, "the scheme is part of it");
  assert.strictEqual(authed(req({}), TOKEN), false);
});

test("a local browser does not get in on locality alone when a token is set", () => {
  // The dashboard is admitted by the separate BROWSER_ROUTES path in server.mjs,
  // not by this function. If authed() ever waved loopback through, every route
  // including run_shell would be open to anything on the machine.
  assert.strictEqual(authed(req({}, "127.0.0.1"), TOKEN), false);
});

test("with NO token, a genuinely local request is still allowed", () => {
  // The dev convenience, deliberately kept. This is the case that cannot be
  // reached by unsetting an env var, because the value lives in cleetus.env.
  assert.strictEqual(authed(req({}, "127.0.0.1"), ""), true);
  assert.strictEqual(authed(req({}, "::1"), ""), true);
});

test("with NO token, a tunnelled request is REFUSED", () => {
  // The whole point. This used to return true unconditionally, so a missing
  // CLEETUSD_TOKEN opened the front door to the internet while the daemon came
  // up looking perfectly healthy.
  for (const h of [
    { "x-forwarded-for": "203.0.113.9" },
    { "x-forwarded-proto": "https" },
    { "x-forwarded-host": "me.cleetusai.com" },
    { "cf-connecting-ip": "203.0.113.9" },
  ]) assert.strictEqual(authed(req(h), ""), false, JSON.stringify(h));
});

test("with NO token, a non-loopback peer is refused", () => {
  assert.strictEqual(authed(req({}, "192.168.1.50"), ""), false);
  assert.strictEqual(authed(req({}, ""), ""), false);
});

test("cloudflared connecting from loopback is not mistaken for a local browser", () => {
  // The trap this design exists for: the tunnel connects to 127.0.0.1, so the
  // peer address alone cannot tell a stranger from the browser on this desk.
  assert.strictEqual(isLocalBrowser(req({ "cf-connecting-ip": "203.0.113.9" })), false);
  assert.strictEqual(isLocalBrowser(req({}, "::ffff:127.0.0.1")), true);
});
