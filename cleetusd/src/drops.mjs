// src/drops.mjs — what happens when Grayson drags something into the chat.
//
// Until now the only way to put a file in front of Cleetus was to name its
// path, which means knowing the path. That is fine for a repo and useless for
// the thing that is actually in front of him: a screenshot he just took, a
// clip somebody sent him, a PDF contract, a CSV his accountant emailed. Those
// live in Downloads under a name nobody can type from memory, and asking him
// to go find the path is asking him to do the computer's job.
//
// So: drop it on the window. This module is the receiving end.
//
// THREE THINGS HAPPEN TO A DROPPED FILE, and which ones depends on what it is:
//
//   1. IT LANDS ON DISK, always, under ~/cleetusd/media/drops with its own name
//      kept. That path goes into the message, which is what makes the rest of
//      the daemon useful on it — read_file, the shell, ffmpeg, the editor, the
//      media agent. A file the agent cannot reach later is a file he can only
//      talk about once.
//
//   2. IT GETS EYES, when it is something to look at. Images are downscaled to
//      1024px and handed back as base64 so they can ride into the conversation
//      as a real image block; the vision path in agent.mjs already knows what
//      to do with one. A VIDEO gets a frame pulled out of it at the one-second
//      mark and treated the same way, because "I dropped a video in and he said
//      he cannot see videos" is a true sentence and a useless product.
//
//   3. IT GETS READ, when it is words. PDFs, Word files, RTF, HTML, CSV, code,
//      plain text — extracted here and inlined, so the answer to "what does
//      this say" does not cost a tool call and does not depend on the model
//      thinking to make one. Nothing new was installed for this: pdftotext and
//      textutil are already on the machine, and there is a Quartz fallback for
//      the PDF that pdftotext chokes on.
//
// EVERYTHING IS LOCAL. The bytes go from the browser to a folder on this Mac
// and nowhere else — same bargain as the rest of Cleetus, and the reason it is
// safe to drop a contract or a bank statement on the window at all.

import { mkdir, stat, readFile, unlink, readdir } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { CONFIG } from "./config.mjs";

const run = promisify(execFile);

/**
 * Where a helper binary actually is on this machine.
 *
 * Hardcoding /opt/homebrew is right until the day it is not: an Intel Mac puts
 * Homebrew in /usr/local, and a bare name resolves against the daemon's PATH,
 * which under launchd does not contain either. So the candidates are tried in
 * order and the bare name is the last resort rather than the first guess — the
 * same shape media_cli.py already uses for ffmpeg, for the same reason.
 */
function bin(name, ...candidates) {
  for (const c of candidates) if (existsSync(c)) return c;
  return name;
}
const FFMPEG  = () => bin("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg");
const FFPROBE = () => bin("ffprobe", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe");
const PDFTOTEXT = () => bin("pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext");

export const DROPS_DIR = process.env.CLEETUSD_DROPS_DIR ||
  `${CONFIG.home}/cleetusd/media/drops`;

// A drop is a thing a human is holding, not a bulk upload path. The ceiling is
// generous enough for a phone video and low enough that a mis-drop of a disk
// image cannot fill the volume while nobody is watching.
export const MAX_DROP_BYTES = 512 * 1024 * 1024;

// What actually reaches the model as inline text. The whole file is on disk
// either way, and the message says so, so a long document is one read_file
// away rather than lost. Past roughly this much the local model's context is
// the thing that breaks, and it breaks by silently dropping the beginning of
// the conversation, which is worse than a truncation it is told about.
const MAX_INLINE_TEXT = 24_000;

// The long side an image is reduced to before it becomes an image block.
// qwen2.5vl does not read a 12-megapixel photograph any better than a 1024px
// one, and the base64 of the original is several megabytes of context.
const VISION_LONG_EDGE = 1024;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".wmv"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".aiff", ".aif", ".caf", ".ogg", ".opus"]);
// Words, but not as bytes you can just read — each needs a converter.
const DOC_EXT = new Set([".pdf", ".doc", ".docx", ".rtf", ".rtfd", ".odt", ".pages", ".html", ".htm", ".webarchive", ".epub"]);
// Words that ARE bytes you can just read.
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".log", ".xml", ".srt", ".vtt",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".sh", ".zsh", ".bash", ".sql", ".css", ".scss",
  ".toml", ".ini", ".conf", ".env", ".gitignore", ".plist", ".patch", ".diff",
]);

/** What sort of thing is this, in the only terms the rest of the code cares about. */
export function kindFor(name, mime = "") {
  const e = extname(String(name || "")).toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (IMAGE_EXT.has(e) || m.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(e) || m.startsWith("video/")) return "video";
  if (AUDIO_EXT.has(e) || m.startsWith("audio/")) return "audio";
  if (DOC_EXT.has(e)) return "document";
  if (TEXT_EXT.has(e) || m.startsWith("text/") || m === "application/json") return "text";
  return "other";
}

/**
 * A filename that is safe to join onto a directory, with his own name kept.
 *
 * Kept, because the name is information: "Q3-invoice-magnolia.pdf" tells the
 * agent what the file is before anything opens it, and a UUID tells it nothing.
 * The timestamp prefix is what stops two drops of "IMG_4821.HEIC" from becoming
 * one file, and it sorts, which makes the folder browsable a month later.
 *
 * The sanitising is a boundary check, not a clever cleaner: anything that is
 * not a plain name character becomes an underscore, so no separator, no dot
 * segment and no control byte survives to be interpreted by a path join.
 */
let dropSeq = 0;
export function safeName(name) {
  const base = basename(String(name || "file")).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  const trimmed = base.slice(-120) || "file";
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  // Dropping four files at once is one gesture and lands inside one second. A
  // timestamp alone makes those four into one file, which is a data-loss bug
  // that only ever shows up on the multi-file drop nobody tested.
  const seq = String((dropSeq = (dropSeq + 1) % 1000)).padStart(3, "0");
  return `${stamp}${seq}_${trimmed}`;
}

async function ensureDir() {
  await mkdir(DROPS_DIR, { recursive: true });
}

/**
 * Take the request body straight to disk.
 *
 * Streamed rather than buffered on purpose. A phone video is hundreds of
 * megabytes and Buffer.concat on it is that much resident memory inside the
 * daemon that every other conversation is also living in — the kind of thing
 * that works on the test file and kills the process on the real one.
 *
 * Returns the absolute path, or throws with the reason. A partial file from a
 * cancelled upload is deleted rather than left to look like a real drop.
 */
export async function receive(req, name) {
  await ensureDir();
  const abs = join(DROPS_DIR, safeName(name));
  let bytes = 0;
  let tooBig = false;
  const counter = async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > MAX_DROP_BYTES) { tooBig = true; throw new Error("too_big"); }
      yield chunk;
    }
  };
  try {
    await pipeline(req, counter, createWriteStream(abs));
  } catch (e) {
    await unlink(abs).catch(() => {});
    if (tooBig) {
      throw new Error(`that file is over ${Math.round(MAX_DROP_BYTES / 1024 / 1024)}MB, which is more than a chat attachment should be — put it somewhere on disk and give Cleetus the path instead`);
    }
    throw e;
  }
  if (!bytes) {
    await unlink(abs).catch(() => {});
    throw new Error("the file arrived empty");
  }
  return { path: abs, bytes };
}

/** Bytes, said the way a person says them. */
function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * A small JPEG of an image, as base64, ready to be an image block.
 *
 * sips ships with macOS and handles HEIC, which matters more than it sounds:
 * every photo off his iPhone is HEIC, no browser will decode one into a canvas,
 * and handing the raw bytes to a vision model gets a confident description of
 * nothing. Converting here means a photo taken thirty seconds ago works the
 * same as a PNG screenshot.
 */
async function visionCopy(abs) {
  const tmp = `${abs}.vision.jpg`;
  try {
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(VISION_LONG_EDGE), abs, "--out", tmp],
      { timeout: 60_000 });
    const b = await readFile(tmp);
    await unlink(tmp).catch(() => {});
    return b.toString("base64");
  } catch {
    await unlink(tmp).catch(() => {});
    // sips refused it. That has two very different causes and they must not be
    // treated the same. Either it is a real picture in a container sips does
    // not convert — in which case sending the original is right — or it is not
    // a picture at all: a truncated download, a renamed text file, an HTML
    // error page with a .png on the end.
    //
    // The first version of this sent the bytes either way, and a 27-byte file
    // reading "this is not an image at all" went to the vision model as base64.
    // A vision model handed nonsense does not say so; it describes something.
    // That is the single worst failure this file can produce, because the
    // answer that comes back is fluent and about nothing.
    //
    // So the bytes have to LOOK like an image before they are called one. The
    // magic numbers are the only honest test available here, and a file that
    // fails it gets no eyes and a note saying why.
    try {
      const raw = await readFile(abs);
      if (raw.length <= 6 * 1024 * 1024 && looksLikeImage(raw)) return raw.toString("base64");
    } catch { /* fall through to no eyes */ }
    return null;
  }
}

/**
 * Do these bytes begin the way an image begins?
 *
 * Header signatures, checked at the front of the file. Deliberately a
 * whitelist: an unrecognised header means no picture is claimed, which is the
 * safe direction when the cost of being wrong is a confident description of a
 * file that was never an image.
 */
function looksLikeImage(b) {
  if (b.length < 12) return false;
  const at = (i, ...bytes) => bytes.every((v, k) => b[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return true;                       // PNG
  if (at(0, 0xff, 0xd8, 0xff)) return true;                             // JPEG
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return true;                       // GIF8
  if (at(0, 0x42, 0x4d)) return true;                                   // BMP
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return true; // TIFF
  // RIFF....WEBP, and the ISO-BMFF family (....ftyp) that carries HEIC and AVIF.
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return true;
  if (b.toString("latin1", 4, 8) === "ftyp") return true;
  return false;
}

/** ffprobe, reduced to the four things worth saying about a clip. */
async function probe(abs) {
  try {
    const { stdout } = await run(FFPROBE(), [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", abs,
    ], { timeout: 30_000, maxBuffer: 4_000_000 });
    const j = JSON.parse(stdout);
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    const a = (j.streams || []).find((s) => s.codec_type === "audio");
    const dur = Number(j.format?.duration);
    return {
      seconds: Number.isFinite(dur) ? Math.round(dur * 10) / 10 : null,
      width: v?.width || null,
      height: v?.height || null,
      video_codec: v?.codec_name || null,
      audio_codec: a?.codec_name || null,
    };
  } catch { return null; }
}

/**
 * One frame out of a video, so a dropped clip is something he can be asked
 * about rather than something to be told about.
 *
 * A second in, not frame zero: the first frame of a phone video is very often
 * black, a lens still opening, or a hand over the camera, and describing that
 * accurately is the same as describing nothing. Clamped for a clip shorter than
 * a second so a half-second GIF still yields a picture.
 */
async function posterFrame(abs, seconds) {
  const at = seconds && seconds < 1.5 ? 0 : 1;
  const tmp = `${abs}.poster.jpg`;
  try {
    await run(FFMPEG(), [
      "-v", "error", "-y", "-ss", String(at), "-i", abs,
      "-frames:v", "1", "-vf", `scale='min(${VISION_LONG_EDGE},iw)':-2`, tmp,
    ], { timeout: 120_000 });
    const b = await readFile(tmp);
    await unlink(tmp).catch(() => {});
    return b.toString("base64");
  } catch {
    await unlink(tmp).catch(() => {});
    return null;
  }
}

/* ── What was SAID in it ──────────────────────────────────────────────────────
   This file used to tell the model, about any audio he dropped: "nothing on
   this machine transcribes it yet — say so rather than guessing what is in
   it." That was written without looking. whisper.cpp is installed, and three
   models are already sitting in ~/.cache/whisper-models including
   large-v3-turbo, which did a five-second clip in 1.4 seconds and got the
   money and the time right:

       "The venue wants a $1,500 deposit by Friday, and the load-in is at 4.30."

   A claim about what the machine cannot do is worth checking before it is
   written down, because nobody re-checks it afterwards — it just quietly caps
   what the assistant is willing to try.

   VIDEO GETS THIS TOO, and that is the bigger half. A dropped clip already
   yields one frame to look at; the soundtrack is usually where the actual
   content is. A voice memo, a rehearsal, somebody explaining something on a
   call. */
const WHISPER_MODELS = [
  // Best first. Turbo is large-quality at roughly three times real time here.
  "ggml-large-v3-turbo.bin",
  "ggml-small.en.bin",
  "ggml-base.en.bin",
];

function whisperModel() {
  for (const name of WHISPER_MODELS) {
    const p = `${CONFIG.home}/.cache/whisper-models/${name}`;
    if (existsSync(p)) return p;
  }
  return null;
}
const WHISPER = () => bin("whisper-cli", "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli");

/**
 * Speech in a file, as text. Null when there is nothing to hear or no way to
 * hear it — never a guess, and never an empty string dressed up as silence.
 */
async function transcribe(abs, seconds) {
  const model = whisperModel();
  if (!model || !existsSync(WHISPER())) return { error: "whisper is not installed on this Mac" };

  const wav = `${abs}.16k.wav`;
  try {
    // whisper.cpp wants 16kHz mono PCM and will refuse anything else, which is
    // what the first attempt at this ran into. -vn drops the video stream so a
    // clip costs no more than its soundtrack.
    await run(FFMPEG(), ["-v", "error", "-y", "-i", abs, "-vn",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { timeout: 300_000 });
  } catch {
    await unlink(wav).catch(() => {});
    // Overwhelmingly this is a video with no audio track at all, which is a
    // fact about the file rather than a failure.
    return { error: "no audio track in it" };
  }

  try {
    // Roughly 3x real time on this machine, so the ceiling is generous and
    // scaled to the clip rather than fixed.
    const budget = Math.min(20 * 60_000, Math.max(120_000, (seconds || 60) * 1500));
    const { stdout } = await run(WHISPER(), ["-m", model, "-f", wav, "-nt", "-np"],
      { timeout: budget, maxBuffer: 20_000_000 });
    const text = String(stdout || "").trim();
    return text ? { text, model: basename(model) } : { error: "no speech in it" };
  } catch (e) {
    return { error: `transcription failed: ${String(e.message || e).split("\n")[0].slice(0, 120)}` };
  } finally {
    await unlink(wav).catch(() => {});
  }
}

/**
 * The words inside a document.
 *
 * Everything here was already installed: pdftotext came with poppler, textutil
 * is part of macOS and converts Word, RTF, HTML and OpenDocument. The Quartz
 * fallback is for the PDFs pdftotext returns nothing useful for — it is the
 * same renderer Preview uses, and it is the difference between "I could not
 * read your contract" and reading the contract.
 *
 * A scanned PDF has no text layer at all and no converter invents one. That
 * case says so plainly instead of returning an empty string that reads as an
 * empty document.
 */
async function documentText(abs) {
  const e = extname(abs).toLowerCase();

  if (e === ".pdf") {
    for (const attempt of [
      () => run(PDFTOTEXT(), ["-layout", "-q", abs, "-"], { timeout: 120_000, maxBuffer: 20_000_000 }),
      () => run("/usr/bin/python3", ["-c", QUARTZ_PDF, abs], { timeout: 120_000, maxBuffer: 20_000_000 }),
    ]) {
      try {
        const { stdout } = await attempt();
        if (stdout && stdout.trim().length > 20) return stdout;
      } catch { /* try the next one */ }
    }
    return { empty: "this PDF has no text layer — it is images of pages (a scan or an export), so nothing can be read out of it without OCR" };
  }

  try {
    const { stdout } = await run("/usr/bin/textutil",
      ["-convert", "txt", "-stdout", abs], { timeout: 120_000, maxBuffer: 20_000_000 });
    if (stdout && stdout.trim()) return stdout;
  } catch { /* fall through */ }
  return { empty: `nothing readable could be extracted from a ${e || "file"} of this kind` };
}

// Kept as a string rather than a file so the module stays self-contained: this
// is the only place it is used and it exists purely as pdftotext's understudy.
const QUARTZ_PDF = `
import sys
from Quartz import PDFDocument
from Foundation import NSURL
pdf = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(sys.argv[1]))
if pdf is None:
    sys.exit(1)
sys.stdout.write(pdf.string() or "")
`.trim();

/**
 * Everything the chat needs to know about one dropped file.
 *
 * The shape is deliberately flat and deliberately honest: `vision` is present
 * only when there is genuinely a picture to look at, `text` only when words
 * were genuinely extracted, and `note` carries the reason when one of those is
 * missing. A caller that finds neither knows the file is on disk and nothing
 * more, which is a true thing to tell the model — and true beats helpful here,
 * because the failure this whole feature invites is an assistant discussing a
 * document it never read.
 */
export async function describe(abs, { bytes, mime, original } = {}) {
  // The name he gave it, not the one the disk gave it. The timestamp prefix
  // exists so two drops of IMG_4821.HEIC stay two files; showing it back to
  // him — in the chip, in the sentence the model reads — turns "your contract"
  // into "20260819051106001_contract.pdf", which is the computer's business
  // and not his. The path carries the real one; everything a human or a model
  // reads carries his.
  const name = original || basename(abs);
  const size = bytes ?? (await stat(abs).catch(() => ({ size: 0 }))).size;
  const kind = kindFor(name, mime);
  const d = { ok: true, path: abs, name, kind, bytes: size, size: human(size) };

  if (kind === "image") {
    d.vision = await visionCopy(abs);
    if (!d.vision) d.note = "this file is named like an image but nothing on this Mac can decode it as one — it may be truncated, or not actually an image. Do not describe its contents: you have not seen any. The bytes are on disk.";
    return d;
  }

  if (kind === "video") {
    const info = await probe(abs);
    if (info) Object.assign(d, info);
    d.vision = await posterFrame(abs, info?.seconds);
    d.frame_at = d.vision ? (info?.seconds && info.seconds < 1.5 ? 0 : 1) : null;
    if (!d.vision) d.note = "no frame could be pulled out of this clip, but the file is on disk";
    // The soundtrack is usually where the content actually is. One frame shows
    // what it looks like; this is what was said in it.
    if (info?.audio_codec) {
      const heard = await transcribe(abs, info?.seconds);
      if (heard.text) {
        d.text = heard.text.length > MAX_INLINE_TEXT
          ? `${heard.text.slice(0, MAX_INLINE_TEXT)}\n\n[…truncated at ${MAX_INLINE_TEXT} of ${heard.text.length} characters.]`
          : heard.text;
        d.transcribed_by = heard.model;
      }
    }
    return d;
  }

  if (kind === "audio") {
    const info = await probe(abs);
    if (info) d.seconds = info.seconds;
    const heard = await transcribe(abs, d.seconds);
    if (heard.text) {
      d.text = heard.text.length > MAX_INLINE_TEXT
        ? `${heard.text.slice(0, MAX_INLINE_TEXT)}\n\n[…truncated at ${MAX_INLINE_TEXT} of ${heard.text.length} characters. The audio is at ${abs}.]`
        : heard.text;
      d.transcribed_by = heard.model;
    } else {
      d.note = `audio: on disk and playable, but ${heard.error}. Do not guess what is in it.`;
    }
    return d;
  }

  if (kind === "text") {
    try {
      const raw = await readFile(abs, "utf8");
      d.text = raw.length > MAX_INLINE_TEXT
        ? `${raw.slice(0, MAX_INLINE_TEXT)}\n\n[…truncated at ${MAX_INLINE_TEXT} of ${raw.length} characters. The whole file is at ${abs} — read_file it for the rest.]`
        : raw;
      if (!raw.trim()) d.note = "the file is empty";
    } catch (e) {
      d.note = `could not be read as text (${e.message}); the file is on disk`;
    }
    return d;
  }

  if (kind === "document") {
    const got = await documentText(abs);
    if (typeof got === "string") {
      d.text = got.length > MAX_INLINE_TEXT
        ? `${got.slice(0, MAX_INLINE_TEXT)}\n\n[…truncated at ${MAX_INLINE_TEXT} of ${got.length} characters. The whole document is at ${abs} — read more of it with the shell if you need it.]`
        : got;
    } else {
      d.note = got.empty;
    }
    return d;
  }

  d.note = "no reader on this machine handles this kind of file, but it is on disk and the shell can look at it";
  return d;
}

/**
 * The name to show him, and to put in the sentence the model reads.
 *
 * A drop is no longer always a loose file. Dropping a FOLDER on a chat window
 * sends every file under it, and the header carries each one's path relative to
 * that folder rather than a bare name — which is the whole point of walking the
 * folder at all. A shoot is forty files called IMG_0001.HEIC and "day2/IMG_0001
 * .HEIC" is the only thing that says which one this is. basename() threw that
 * away, so every file in a dropped folder arrived looking like every other.
 *
 * Never used to build a path. safeName does that, from the same string, and
 * flattens it to one segment on its way to disk. This is for eyes only — and
 * the dot segments and leading slashes come off regardless, so nothing shaped
 * like an escape ever reaches a screen claiming to be where a file came from.
 */
export function displayName(name) {
  const parts = String(name || "").split("/").filter((p) => p && p !== "." && p !== "..");
  // The last few segments, not the whole tree: the useful context is the folder
  // it sat in, and a path eleven deep is a chip nobody can read.
  return parts.slice(-4).join("/") || "file";
}

/** Receive and describe in one go — what the route actually wants. */
export async function acceptDrop(req, { name, mime }) {
  const { path, bytes } = await receive(req, name);
  return describe(path, { bytes, mime, original: displayName(name) });
}

/**
 * The sentence that goes into the conversation alongside the file.
 *
 * Written here rather than in the browser because both chat surfaces need it
 * to be identical: the deck and /reach are two files, and the moment they word
 * an attachment differently, the same dropped video reads as two different
 * things depending on which window it was dropped on.
 */
export function attachmentLine(d) {
  const bits = [`${d.kind}`, d.size];
  if (d.width && d.height) bits.push(`${d.width}x${d.height}`);
  if (d.seconds != null) bits.push(`${d.seconds}s`);
  let line = `[Grayson attached ${d.name} (${bits.join(", ")}). It is on disk at ${d.path} — use that path with read_file, the shell, ffmpeg or the editor.]`;
  if (d.kind === "image") {
    // The two features are only worth as much as the join between them. A
    // picture he dropped is the best possible input to generate_image, and the
    // agent will not think to use it that way unless the attachment says so:
    // left to itself it describes the picture back in words, which is the lossy
    // step the reference exists to remove.
    line += ` [If he is asking for a picture LIKE this one, edited, restyled or in a different light, ` +
            `pass this path to generate_image as its 'reference' rather than describing it back in words. ` +
            `A description loses the exact colour, grain and composition; the file does not.]`;
  }
  if (d.kind === "video" && d.vision) {
    line += ` [The picture attached with it is a single frame from ${d.frame_at === 0 ? "the start" : "one second in"}, not the whole clip: describe it as a frame and do not claim to have watched the video.]`;
  }
  if (d.note) line += ` [${d.note}]`;
  if (d.text) {
    const what = d.transcribed_by
      ? `what is said in ${d.name} (transcribed on this Mac with ${d.transcribed_by})`
      : `contents of ${d.name}`;
    line += `\n\n--- ${what} ---\n${d.text}\n--- end of ${d.name} ---`;
  }
  return line;
}

/** What is in the drops folder, newest first. For the deck and for housekeeping. */
export async function listDrops(limit = 50) {
  await ensureDir();
  const names = await readdir(DROPS_DIR).catch(() => []);
  const out = [];
  for (const n of names) {
    if (n.startsWith(".") || n.endsWith(".vision.jpg") || n.endsWith(".poster.jpg")) continue;
    const abs = join(DROPS_DIR, n);
    const s = await stat(abs).catch(() => null);
    if (!s || !s.isFile()) continue;
    out.push({ name: n, path: abs, bytes: s.size, size: human(s.size), kind: kindFor(n), mtime: s.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}
