// src/wemo.mjs — the Belkin WeMo plug (the keys screen), controlled LOCALLY.
//
// WeMo Mini sockets speak UPnP/SOAP on the LAN with no cloud in the path, so
// this is a direct HTTP call to the plug, faster and more private than the
// Govee cloud path. The keys screen is on the one WeMo on the network
// (192.168.1.156, "Wemo Mini" Socket), added to the Keys station 2026-09-15.
//
// THE PORT MOVES. WeMo picks a port in 49152-49155 at boot and can change it on
// a reboot, so a pinned port goes stale silently. We try the last-known port
// first and fall back across the range, caching whatever answered. If the whole
// range is dead the plug is off the network, which reads as unreachable rather
// than a false state.

const PORTS = [49153, 49152, 49154, 49155];
const lastPort = new Map();   // host -> port that last answered

async function soap(host, port, action, bodyInner, timeout) {
  const r = await fetch(`http://${host}:${port}/upnp/control/basicevent1`, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPACTION: `"urn:Belkin:service:basicevent:1#${action}"`,
    },
    body:
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="urn:Belkin:service:basicevent:1">${bodyInner}</u:${action}></s:Body></s:Envelope>`,
    signal: AbortSignal.timeout(timeout),
  });
  return r.text();
}

// Try the cached port first, then the rest. Returns {text, port} or throws.
async function call(host, action, bodyInner, timeout = 2500) {
  const order = [...new Set([lastPort.get(host), ...PORTS].filter(Boolean))];
  let err;
  for (const port of order) {
    try {
      const text = await soap(host, port, action, bodyInner, timeout);
      lastPort.set(host, port);
      return { text, port };
    } catch (e) { err = e; }
  }
  throw err || new Error("no WeMo port answered");
}

function binaryState(xml) {
  const m = xml.match(/<BinaryState>\s*([^<\s]+)/);
  if (!m) return null;
  // "0" is off; "1" and "8" (on/standby) are on.
  return m[1] !== "0";
}

/** Read the plug: {online, on}. online:false => on is unknown. */
export async function wemoState(host) {
  try {
    const { text } = await call(host, "GetBinaryState", "");
    return { host, online: true, on: binaryState(text) };
  } catch (e) {
    return { host, online: false, on: null, error: String(e.message || e) };
  }
}

/** Switch the plug and read it back. */
export async function wemoSet(host, on) {
  await call(host, "SetBinaryState", `<BinaryState>${on ? 1 : 0}</BinaryState>`, 6000);
  return wemoState(host);
}
