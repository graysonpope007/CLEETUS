// src/tools/web.mjs — a real browser, driven by the loop that is already here.
//
// This replaces a `browse` tool that took a plain-English instruction and posted
// it to `/api/run` on the harness. That endpoint has never existed. The harness
// speaks open / page / act / pending / approve — primitives meant to be driven
// by an agent, not a single do-what-I-mean call. So `browse` could not have
// worked on its best day, and the failure it reported ("the harness is not
// answering — start it with npm start") pointed at the wrong thing entirely:
// starting it would not have helped.
//
// The fix is not a second LLM loop inside a tool. cleetusd already has a tool
// loop with the model in it; the harness primitives are exposed as tools and
// that loop drives them. One loop, one place to debug.
//
// THE CONTRACT, WHICH IS THE POINT OF THE HARNESS
// Reads execute. Commits queue. Anything the other side of the screen cannot
// take back — placing an order, submitting, sending, deleting — comes back as a
// `pending_id` instead of happening, and only a human releases it. Credential
// fields are refused outright and there is no flag to change that.
//
// These tools deliberately expose NO approve. cleetusd holds the disk and the
// shell; handing it the ability to release its own held actions would empty the
// one gate the harness exists to provide.

import { CONFIG } from "../config.mjs";

const BASE = CONFIG.webHarness;

async function call(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(CONFIG.webToken ? { Authorization: `Bearer ${CONFIG.webToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  return r.json();
}

/** The harness being down is the common case; say so once, usefully. */
function unreachable(e) {
  return (
    `The browser harness is not running (${e.message}). ` +
    `Start it with: launchctl kickstart -k gui/$(id -u)/com.cleetus.web`
  );
}

/** Turn a page description into something worth putting in a prompt. */
function render(d) {
  if (!d || d.ok === false) {
    if (d?.error === "host_not_allowed") {
      return `That host is not on the allowlist. Allowed: ${(d.allowlist || []).join(", ")}`;
    }
    if (d?.error === "no_page_open") return "No page is open yet — use web_open first.";
    if (d?.error === "credential_field_refused") return d.detail;
    return `The browser refused that: ${d?.detail || d?.error || "unknown error"}`;
  }
  if (d.gated) {
    return (
      `HELD FOR APPROVAL — nothing was clicked.\n` +
      `  what: ${d.label}\n  why held: ${d.reason}\n  pending_id: ${d.pending_id}\n` +
      `Tell Grayson it is waiting. You cannot release it yourself.`
    );
  }
  const lines = [];
  if (d.clicked) lines.push(`clicked: ${d.clicked}`);
  if (d.typed) lines.push(`typed into: ${d.typed}`);
  if (d.title || d.url) lines.push(`${d.title || "(untitled)"} — ${d.url || ""}`);
  if (d.text) lines.push("\n" + String(d.text).slice(0, 6_000));
  if (Array.isArray(d.elements) && d.elements.length) {
    lines.push(
      "\nthings you can act on (use the index):\n" +
        d.elements.slice(0, 60).map((e, i) => `  [${e.index ?? i}] ${e.label}`).join("\n"),
    );
  }
  return lines.join("\n") || JSON.stringify(d).slice(0, 4_000);
}

export const webTools = {
  web_open: {
    schema: {
      description:
        "Open a URL in Grayson's real browser (signed into his accounts) and read the page back. Use for looking something up, comparing prices, or reading a page that needs a login. Reads happen immediately.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full URL including https://" } },
        required: ["url"],
      },
    },
    async run({ url }) {
      try {
        return render(await call("/api/open", { method: "POST", body: { url } }));
      } catch (e) {
        return unreachable(e);
      }
    },
  },

  web_read: {
    schema: {
      description:
        "Re-read the page currently open in the browser, including the list of things that can be clicked or typed into. Use after acting, to see what changed.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      try {
        return render(await call("/api/page"));
      } catch (e) {
        return unreachable(e);
      }
    },
  },

  web_act: {
    schema: {
      description:
        "Act on the open page: click an element by index, type text into one, scroll, or go back. Anything irreversible (ordering, submitting, sending, deleting) is HELD for Grayson's approval and returns a pending_id instead of happening — that is expected, not an error. Password, card, CVV and SSN fields are always refused.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "click, type, scroll, back, or read" },
          index: { type: "number", description: "Which element, from the list web_read returned." },
          text: { type: "string", description: "For type: what to enter." },
          summary: { type: "string", description: "If this might be irreversible, describe it in Grayson's words so the approval prompt makes sense." },
        },
        required: ["action"],
      },
    },
    async run({ action, index, text, summary }) {
      if ((action === "click" || action === "type") && index === undefined) {
        return `${action} needs an index — call web_read first and use the number in brackets.`;
      }
      try {
        return render(await call("/api/act", { method: "POST", body: { action, index, text, summary } }));
      } catch (e) {
        return unreachable(e);
      }
    },
  },

  web_pending: {
    schema: {
      description:
        "List browser actions waiting on Grayson's approval. Use to tell him what is queued. You cannot approve them.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      try {
        const d = await call("/api/pending");
        if (!d.count) return "Nothing is waiting for approval.";
        return d.pending.map((p) => `  ${p.id}: ${p.summary} (${p.reason}) at ${p.url}`).join("\n");
      } catch (e) {
        return unreachable(e);
      }
    },
  },
};

export async function webReachable() {
  try {
    const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}
