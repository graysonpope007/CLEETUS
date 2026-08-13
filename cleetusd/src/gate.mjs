// src/gate.mjs — who is allowed in.
//
// Split out of server.mjs for one reason: server.mjs starts listening the
// moment it is imported, so nothing could test the gate without standing up a
// real daemon. This is the code that decides whether a stranger reaches
// run_shell, and "we could not test it conveniently" is not a good reason for
// it to be the untested part.

import { CONFIG } from "./config.mjs";

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
export function isLocalBrowser(req) {
  const peer = req.socket?.remoteAddress || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const proxied =
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-proto"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["cf-connecting-ip"];
  return loopback && !proxied;
}

// CLEETUSD_TOKEN is what stands between a stranger and `run_shell`, an
// unrestricted filesystem and a keyring holding real credentials, on a port
// published through a cloudflared tunnel.
//
// This used to return true outright when no token was configured — a dev
// convenience for loopback. The failure mode is that the env var going missing
// is completely silent: the plist loses it, launchd reloads without it, and the
// daemon comes up working perfectly with the front door open to the internet.
// Nothing looks wrong, which is the property that makes it dangerous.
//
// So the convenience now only applies to requests that genuinely originated on
// this machine. isLocalBrowser is the right test rather than a bare loopback
// check, because cloudflared connects to 127.0.0.1 as well — see its comment.
// A tunnelled request with no token configured is refused rather than trusted.
export function authed(req, token = CONFIG.token) {
  if (!token) return isLocalBrowser(req);
  const h = req.headers.authorization || "";
  return h === `Bearer ${token}`;
}
