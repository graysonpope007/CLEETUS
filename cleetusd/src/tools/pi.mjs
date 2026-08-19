// src/tools/pi.mjs — finding a person, starting from a face.
//
// FaceCheck.ID is a reverse face search: give it a photo, it returns where else
// on the web that face appears, with a match score and a source link. That is
// the one capability the PI agent cannot get from the open web tools it already
// has — everything else (a name, a handle, a phone) is searchable text, but a
// face is not, and this turns a face back into links.
//
// KEY-GATED AND HONEST. The API needs a token. It is read from the keyring by
// name (FACECHECK_ID_KEY), never hardcoded and never printed back — the keyring
// is one-way for exactly this. With no key the tool says so and stops rather
// than pretending; a PI agent that invents matches is worse than useless. Add
// the key on the Reach page, under Keys and secrets. (The dashboard at / has
// no such form; only /reach does.)
//
// This is a real capability with real weight. The agent's brief carries the
// judgement about WHEN to use it; the tool just runs the search the way the
// service documents it.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { get as getSecret } from "../keyring.mjs";
import { safeAsset } from "../editor.mjs";

const UPLOAD = "https://facecheck.id/api/upload_pic";
const SEARCH = "https://facecheck.id/api/search";
const NO_KEY =
  "No FaceCheck.ID key is set. Add it as FACECHECK_ID_KEY on the Reach page " +
  "(127.0.0.1:8767/reach) under Keys and secrets, then this works. The dashboard at / has no " +
  "such form — only Reach does. It is stored one-way — " +
  "I can use it but never read it back. Do NOT invent matches in its absence.";

async function faceCheck(imagePath, { testMode = false, timeoutMs = 90_000 } = {}) {
  const token = await getSecret("FACECHECK_ID_KEY");
  if (!token) return { ok: false, error: NO_KEY };

  // Accept a media-folder asset or any readable absolute path the caller names.
  const abs = safeAsset(imagePath) || (existsSync(imagePath) ? imagePath : null);
  if (!abs) return { ok: false, error: `no readable image at ${imagePath}` };

  const bytes = await readFile(abs);
  const form = new FormData();
  form.append("images", new Blob([bytes]), abs.split("/").pop());

  const headers = { Authorization: token, "accept-language": "en" };
  let up;
  try {
    up = await fetch(UPLOAD, { method: "POST", headers, body: form,
      signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
  } catch (e) {
    return { ok: false, error: `upload failed: ${e.message}` };
  }
  if (up.error) return { ok: false, error: `FaceCheck: ${up.message || up.error}` };
  const idSearch = up.id_search;
  if (!idSearch) return { ok: false, error: "FaceCheck did not return a search id" };

  // The search polls: the service crawls in the background and reports progress
  // until the results are ready. testMode returns demo data and does not spend a
  // credit — the right default for wiring checks.
  const body = { id_search: idSearch, with_progress: true, status_only: false, demo: !!testMode };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let s;
    try {
      s = await fetch(SEARCH, { method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
    } catch (e) {
      return { ok: false, error: `search failed: ${e.message}` };
    }
    if (s.error) return { ok: false, error: `FaceCheck: ${s.message || s.error}` };
    if (s.output) {
      const items = (s.output.items || []).map((it) => ({
        score: it.score, url: it.url, source: it.guid,
      }));
      return { ok: true, demo: !!testMode, count: items.length, items };
    }
    // Not ready — wait out the crawl. Progress is a percentage on s.progress.
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, error: "search timed out before results were ready" };
}

export const piTools = {
  face_search: {
    schema: {
      description:
        "Reverse face search: given a photo of a person, find where else that face appears on the web, " +
        "with a match score and source link for each hit. Use for the PI job of identifying or locating a " +
        "person from an image — a screenshot, a profile picture, a photo Grayson has. Uses FaceCheck.ID and " +
        "needs FACECHECK_ID_KEY in the keyring; if it is not set, say so plainly and do not guess. Pass " +
        "test:true to run a free demo search when wiring or when a real credit should not be spent. Treat " +
        "results as leads to verify, never as proof — a high score is a strong lead, not an identification.",
      parameters: {
        type: "object",
        properties: {
          image: { type: "string", description: "Path to the face photo (a media-folder asset or an absolute path)." },
          test: { type: "boolean", description: "Run a free demo search (no credit spent). Default false." },
        },
        required: ["image"],
      },
    },
    async run({ image, test }) {
      const r = await faceCheck(image, { testMode: !!test });
      if (!r.ok) return r.error;
      if (!r.count) return `No matches found for that face${r.demo ? " (demo mode)" : ""}.`;
      const lines = r.items.slice(0, 10).map((it) =>
        `- score ${it.score}: ${it.url || "(no url)"}`);
      return `${r.count} match${r.count === 1 ? "" : "es"}${r.demo ? " (DEMO — not real hits)" : ""}, ` +
             `strongest first. Each is a LEAD to verify, not a confirmed identity:\n${lines.join("\n")}`;
    },
  },
};
