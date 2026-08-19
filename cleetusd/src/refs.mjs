// src/refs.mjs — the pictures that define what something is supposed to look like.
//
// generate_image can start from a reference now, which is the strongest lever
// there is on whether a picture matches what he had in mind. That left an
// obvious hole: the agent can USE a reference and has no idea where to find
// one. The brief's answer was "find_files for existing logo and artwork assets
// on disk", which is an unbounded search of his home directory — the exact
// flailing the repo roster was added to stop, wearing a different hat.
//
// So: a named folder per thing.
//
//     ~/cleetusd/media/refs/glm/*.jpg
//     ~/cleetusd/media/refs/magnolia/*.png
//     ~/cleetusd/media/refs/sky-ciela/*.jpg
//
// He drops pictures in, the agent lists them by name, and a request for "a
// Sky Ciela cover" starts from her last one instead of from a paragraph
// describing it. That is the whole feature, and the reason it is worth having
// is the same reason the reference itself is: the exact blue of a brand
// survives a file and does not survive a sentence.
//
// DELIBERATELY NOT AUTOMATIC. Nothing here picks a reference on his behalf —
// it reports what exists and the agent chooses, out loud, so a picture that
// came out looking like something has a traceable reason. Silently starting
// every GLM request from whatever happens to be first in a folder is the kind
// of helpfulness that becomes impossible to debug.

import { readdir, stat, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename, resolve } from "node:path";
import { CONFIG } from "./config.mjs";

export const REFS_DIR = process.env.CLEETUSD_REFS_DIR ||
  join(CONFIG.home, "cleetusd", "media", "refs");

// Only what a sampler can actually start from. A PDF brand guide in here is a
// reasonable thing for him to keep and not a thing img2img can read, so it is
// listed as an "other" rather than offered as a reference.
const USABLE = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * Every named reference set, with the pictures in it.
 *
 * Newest picture first inside each set, because the most recent artwork for a
 * brand is almost always the one that defines it now.
 */
export async function listReferences() {
  if (!existsSync(REFS_DIR)) return [];
  const names = await readdir(REFS_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(REFS_DIR, entry.name);
    const files = await readdir(dir).catch(() => []);
    const pictures = [];
    let others = 0;
    for (const f of files) {
      if (f.startsWith(".")) continue;
      const ext = extname(f).toLowerCase();
      if (!USABLE.has(ext)) { others++; continue; }
      const abs = join(dir, f);
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isFile()) continue;
      pictures.push({ name: f, path: abs, bytes: s.size, mtime: s.mtimeMs });
    }
    if (!pictures.length && !others) continue;
    pictures.sort((a, b) => b.mtime - a.mtime);
    out.push({ set: entry.name, pictures, others });
  }
  out.sort((a, b) => a.set.localeCompare(b.set));
  return out;
}

/**
 * The sets, as a sentence the model can act on.
 *
 * Names and paths only. The paths matter because the next thing the agent does
 * with one is pass it to generate_image as `reference`, and a name it has to
 * go and resolve is a name it will resolve wrongly.
 */
export function referencesText(sets) {
  if (!sets.length) {
    return "There are no reference sets yet. He can make one by creating a folder under " +
      `${REFS_DIR} named for the brand, artist or look — for example ` +
      `${join(REFS_DIR, "glm")} — and putting a few pictures in it. Then anything he asks ` +
      "for in that style starts from his own artwork instead of from a description of it. " +
      "Ask him for two or three when the look matters and there is nothing here.";
  }
  /* The operative sentence goes at the END of the RESULT, not only in the tool
     description. Measured across four runs of "make a cover for the next GLM
     single": list_references was called 4 times out of 4 — the habit forms —
     and the reference was actually passed to generate_image only twice. It
     looked, and then half the time it styled from scratch anyway.

     The description is read before the call. The result is the last thing in
     context before the next action, which is the one that matters. */
  const body = sets.map((s) => {
    const shown = s.pictures.slice(0, 4).map((p) => `    ${p.path}`).join("\n");
    const more = s.pictures.length > 4 ? `\n    …and ${s.pictures.length - 4} more` : "";
    const note = s.others ? `  (${s.others} non-image file(s) in here, which cannot be a reference)` : "";
    return `  ${s.set} — ${s.pictures.length} picture(s)${note}\n${shown}${more}`;
  }).join("\n");

  const usable = sets.filter((s) => s.pictures.length);
  if (!usable.length) {
    return `${body}\n\nNone of these has a picture a sampler can start from. Ask him for two or ` +
      `three, and say which set they are for.`;
  }
  return `${body}\n\nNEXT: if one of these sets is what he is asking for, pass that exact path to ` +
    `generate_image as \`reference\` — copy it from the list above rather than retyping it — and say ` +
    `which picture you started from. Starting from his own artwork is the whole point of the folder; ` +
    `listing it and then styling from scratch produces a competent picture that looks like nobody. ` +
    `If none of them fits, say so plainly and generate without one.`;
}

/* ── Putting a picture INTO a set ────────────────────────────────────────────
   Listing them was half a feature. The other half is how they get there, and
   the answer was "move files by hand", which means the folder stays empty and
   the whole thing is a good idea nobody uses.

   Now: he drops a picture on the chat and says keep this for GLM. The drop is
   already on disk with a path in the message, so filing it is a copy.

   COPY, never move. The drops folder is the record of what he sent, and a
   reference set is a curated thing he will prune. Moving would mean filing a
   picture silently removes it from the conversation it arrived in, and the
   answer he reads still names the old path. */

/** A set name that is safe to be a folder, and recognisable a month later. */
export function safeSetName(name) {
  return String(name || "")
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * File a picture into a named set. Returns where it landed, or an error that
 * says which of the several possible things went wrong.
 */
export async function saveReference(picturePath, setName) {
  const set = safeSetName(setName);
  if (!set) return { ok: false, error: "no set name — give it one, like glm or sky-ciela or warm-film" };

  const src = resolve(String(picturePath || "").replace(/^~/, CONFIG.home));
  if (!existsSync(src)) return { ok: false, error: `no such picture: ${src}` };
  const ext = extname(src).toLowerCase();
  if (!USABLE.has(ext)) {
    return { ok: false,
      error: `a ${ext || "file with no extension"} cannot be a reference — a sampler starts from ` +
             `png, jpg, jpeg or webp. Keep it in the folder if it is a brand guide, but it will be ` +
             `listed as unusable rather than offered.` };
  }

  const dir = join(REFS_DIR, set);
  await mkdir(dir, { recursive: true });

  /* His own name for the file, kept — "sky-ciela-last-single.jpg" says what it
     is a year later and a timestamp does not. Collisions get a suffix rather
     than overwriting, because the picture already in the set is one he chose
     and this one is only the newest. */
  const base = basename(src).replace(/[^A-Za-z0-9._-]/g, "_");
  let dest = join(dir, base);
  for (let n = 2; existsSync(dest); n++) {
    const stem = base.replace(/\.[^.]+$/, "");
    dest = join(dir, `${stem}-${n}${ext}`);
    if (n > 50) return { ok: false, error: "too many files by that name in the set" };
  }

  await copyFile(src, dest);
  return { ok: true, path: dest, set, copiedFrom: src };
}
