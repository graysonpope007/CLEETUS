// src/tools/mail.mjs — actually sending, as Grayson.
//
// He was asked how email should work and picked "send freely to anyone" over a
// draft-and-approve flow. The cloud app was built for that: /api/google/send
// sends for real, logs every message to sent_emails BEFORE the call so a
// mistake is findable afterwards, and has one kill switch, EMAIL_SEND_ENABLED=0.
//
// The local Cleetus — the one with the disk, the shell and the cameras, the one
// he actually talks to — had no way to send at all. The decision was made and
// the endpoint was built, and the half he uses could only ever draft.
//
// WHY THIS ISN'T GATED HERE
// A confirmation step in this tool would be theatre: cleetusd is already the
// most privileged thing on this machine, and adding a prompt here would only
// train the model to answer its own prompt. The real protections are the ones
// the endpoint already has — a session, an append-only record of every send,
// and a switch that turns it off without a deploy. Reproducing them badly here
// would make the system look safer while changing nothing.
//
// Outlook cannot send: that grant is Mail.ReadWrite, which does not cover it.
// Gmail's is gmail.modify, which does.

import { CONFIG } from "../config.mjs";

let cookie = null;
async function session() {
  if (cookie) return cookie;
  if (!CONFIG.sitePassword) throw new Error("SITE_PASSWORD not set; cannot reach the cloud app");
  const r = await fetch(`${CONFIG.cloud}/api/session/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: CONFIG.cloud },
    body: JSON.stringify({ password: CONFIG.sitePassword }),
  });
  const sc = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith("cleetus_session="));
  if (!sc.length) throw new Error("cloud login failed");
  cookie = sc.join("; ");
  return cookie;
}

export const mailTools = {
  send_email: {
    schema: {
      description:
        "Send an email as Grayson, for real, to anyone. It goes immediately — there is no draft step and no approval, so write it finished and get the address right. Every send is recorded. Use this when he asks you to email, reply to, or follow up with someone.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient address. Comma-separate several." },
          subject: { type: "string", description: "Subject line." },
          body: { type: "string", description: "The message, finished, in his voice. Plain text." },
          cc: { type: "string", description: "Optional cc addresses." },
          bcc: { type: "string", description: "Optional bcc addresses." },
        },
        required: ["to", "subject", "body"],
      },
    },
    async run({ to, subject, body, cc, bcc }) {
      // A missing address is caught upstream by the required-argument check, but
      // an address with no @ in it is a different mistake and worth naming: it
      // is usually the model having written a person's name where the address
      // goes, and sending that fails in a way nobody sees.
      if (!/@/.test(String(to))) {
        return `"${to}" is not an email address. Nothing was sent — find the real address first (his contacts are in the vault, and cloud_api can read his mail).`;
      }
      try {
        const r = await fetch(`${CONFIG.cloud}/api/google/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: await session(), Origin: CONFIG.cloud },
          body: JSON.stringify({ to, subject, body, cc, bcc }),
          signal: AbortSignal.timeout(60_000),
        });
        const d = await r.json().catch(() => ({}));
        if (d.ok) return `Sent to ${to}: "${subject}". It is recorded in sent_emails.`;
        if (d.error === "sending_disabled") {
          return "Sending is switched off (EMAIL_SEND_ENABLED=0). Nothing was sent. Tell him it is off rather than trying another way.";
        }
        return `Not sent: ${d.detail || d.error || `http ${r.status}`}`;
      } catch (e) {
        return `Not sent — could not reach the mail endpoint (${e.message}). Do not claim it went.`;
      }
    },
  },
};
