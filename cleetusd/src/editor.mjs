// src/editor.mjs — the cutting room. A timeline in, one MP4 out.
//
// OpenCut is the reference (an open CapCut), but its own editor is a "coming
// soon" stub right now and Cleetus is a place of single-file, zero-build pages
// (deck.html, reach.html, the dashboard), not a 200 MB Next app. So this takes
// OpenCut's MODEL — a track of clips, each with a source, an in/out trim and a
// place on the timeline — and renders it the way this machine already renders
// everything else: one ffmpeg pass, no intermediate files, no service to keep
// alive. The generated pictures and clips from the media agent are the bin.
//
// ONE PASS ON PURPOSE. The naive way is to trim each clip to its own temp file
// and concat the files — but that is N encodes and a pile of temp state that
// outlives a crash. A single filter_complex graph trims, scales, pads and
// concatenates every clip in the same invocation, so the only output is the one
// the user asked for and a failed export leaves nothing behind to sweep.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { CONFIG } from "./config.mjs";

const FFMPEG = process.env.CLEETUSD_FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.CLEETUSD_FFPROBE || "/opt/homebrew/bin/ffprobe";
export const MEDIA_DIR = process.env.CLEETUSD_MEDIA_OUT || join(CONFIG.home, "cleetusd", "media", "out");
export const PROJECT_DIR = join(CONFIG.home, "cleetusd", "media", "projects");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

export function kindOf(name) {
  const e = extname(name).toLowerCase();
  if (IMAGE_EXT.has(e)) return "image";
  if (VIDEO_EXT.has(e)) return "video";
  return null;
}

/**
 * A path is only allowed if it resolves inside a folder media is kept in.
 *
 * The editor takes asset paths from the browser, and an export shells out to
 * ffmpeg with them — so a path is a capability. Without this fence, a clip
 * pointing at ../../.ssh/id_rsa would be read and muxed into a video. Every
 * asset path, for preview and for export, goes through here first; anything
 * that escapes is refused rather than sanitised, because a clever sanitiser is
 * a thing that gets outsmarted and a boundary check is not.
 *
 * TWO ROOTS NOW, and the second one is why a dropped picture could not be
 * seen. Files Grayson drops land in media/drops, this fence only knew about
 * media/out, and /editor/asset is the ONLY route that serves a file to a chat
 * window. So every dropped picture was refused by the display path — the photo
 * he had just sent from his phone could not be shown back to him, and an
 * answer that named the reference it started from rendered as a dead path.
 *
 * That is the same shape as the fault the media agent already has a memory of:
 * the generator was making a file every time and the DISPLAY was what was
 * broken. Worth stating plainly, because both times it looked like the feature
 * had not worked.
 *
 * Widening it is safe on its own terms and not merely convenient: drops holds
 * files Grayson himself put there through an authenticated route, under names
 * this daemon sanitised, which is the same provenance as everything in
 * media/out. What the fence exists to stop — a path pointing anywhere ELSE on
 * the disk — is unchanged.
 */
const ASSET_ROOTS = [
  MEDIA_DIR,
  process.env.CLEETUSD_DROPS_DIR || join(CONFIG.home, "cleetusd", "media", "drops"),
];

export function safeAsset(p) {
  if (!p) return null;
  // A bare name still means the generated-media folder, which is what every
  // existing caller passes and what the editor's bin is built from.
  const abs = resolve(p.startsWith("/") ? p : join(MEDIA_DIR, p));
  const inside = ASSET_ROOTS.some((dir) => {
    const root = resolve(dir);
    return abs === root || abs.startsWith(root + "/");
  });
  if (!inside) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

/** The media bin: every image and clip in the folder, newest first. */
export async function listMedia() {
  const out = [];
  // Both roots. A clip he DROPPED is the most obvious thing in the world to
  // want in a cutting room, and it was the one thing the bin could not show:
  // the folder was generated-media only, so a video off his phone arrived on
  // the Mac and then had to be found by hand to do anything with.
  //
  // `origin` rather than two lists, because the timeline does not care where a
  // clip came from and the page can label it if it wants to.
  for (const [dir, origin] of [[MEDIA_DIR, "made"], [ASSET_ROOTS[1], "dropped"]]) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      const kind = kindOf(name);
      if (!kind) continue;
      if (name.endsWith(".keyframe.png")) continue;   // internal, not a bin asset
      if (name.endsWith(".vision.jpg") || name.endsWith(".poster.jpg")) continue; // drops' own scratch
      const abs = join(dir, name);
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isFile()) continue;
      out.push({ name, kind, origin, path: abs, bytes: s.size, mtime: s.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** A video's duration in seconds, so a trimmed clip knows its own bounds. */
export function probeDuration(absPath) {
  return new Promise((res) => {
    execFile(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", absPath],
      { timeout: 15_000 }, (err, stdout) => {
        const d = parseFloat(String(stdout || "").trim());
        res(Number.isFinite(d) ? d : null);
      });
  });
}

// ── The filtergraph ──────────────────────────────────────────────────────────

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Turn a timeline into ffmpeg arguments.
 *
 * timeline = { width, height, fps, clips: [ {asset, kind, inPoint, outPoint, duration} ] }
 *   image clip: shown for `duration` seconds.
 *   video clip: the span inPoint..outPoint of the source is used (defaults to
 *               the whole file), and duration is derived from that span.
 * Returns { args, outPath, clips } or throws with a plain reason.
 */
export function buildExport(timeline, outPath) {
  const W = clamp(Math.round(timeline.width || 1024), 16, 3840);
  const H = clamp(Math.round(timeline.height || 1024), 16, 2160);
  const FPS = clamp(Math.round(timeline.fps || 30), 1, 60);
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  if (!clips.length) throw new Error("the timeline is empty");

  const inputs = [];
  const filters = [];
  const labels = [];

  clips.forEach((clip, i) => {
    // A black card is a synthetic source, not a file — a lead-in/out that needs
    // no asset. Handled before the path fence because there is no path to fence.
    if (clip.asset === "__black__" || clip.kind === "black") {
      const dur = clamp(Number(clip.duration) || 2, 0.1, 600);
      inputs.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", `color=c=black:s=${W}x${H}:r=${FPS}`);
      filters.push(`[${i}:v]format=yuv420p,setsar=1,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      labels.push(`[v${i}]`);
      return;
    }

    const abs = safeAsset(clip.asset);
    if (!abs) throw new Error(`clip ${i + 1} points outside the media folder or does not exist`);
    const kind = clip.kind || kindOf(abs);

    if (kind === "image") {
      const dur = clamp(Number(clip.duration) || 3, 0.1, 600);
      // A still becomes a clip by looping one frame for `dur` seconds.
      inputs.push("-loop", "1", "-t", dur.toFixed(3), "-i", abs);
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},` +
        `format=yuv420p,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    } else if (kind === "video") {
      const inP = clamp(Number(clip.inPoint) || 0, 0, 1e6);
      // outPoint may be absent (use to end) — represented as a large trim end.
      const outP = clip.outPoint != null ? clamp(Number(clip.outPoint), inP + 0.05, 1e6) : null;
      const trim = outP != null ? `trim=start=${inP.toFixed(3)}:end=${outP.toFixed(3)}`
                                : `trim=start=${inP.toFixed(3)}`;
      inputs.push("-i", abs);
      filters.push(
        `[${i}:v]${trim},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},` +
        `format=yuv420p[v${i}]`);
    } else {
      throw new Error(`clip ${i + 1} is neither image nor video`);
    }
    labels.push(`[v${i}]`);
  });

  const concat = `${labels.join("")}concat=n=${clips.length}:v=1:a=0[outv]`;
  const filterComplex = filters.concat(concat).join(";");

  const args = [
    "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[outv]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ];
  return { args, outPath, width: W, height: H, fps: FPS, clipCount: clips.length };
}

/** Render a timeline to `outPath`. Resolves with a result object, never throws. */
export function exportTimeline(timeline, outPath) {
  let plan;
  try {
    plan = buildExport(timeline, outPath);
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message });
  }
  return new Promise((res) => {
    // Wall-clock budget scales with the number of clips; a long stack of video
    // clips is real encoding work. Floor keeps a one-image export snappy.
    const ms = Math.max(60_000, plan.clipCount * 45_000);
    execFile(FFMPEG, plan.args, { timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000 },
      (err, _stdout, stderr) => {
        if (err) {
          return res({
            ok: false,
            error: err.killed
              ? `export did not finish in ${Math.round(ms / 1000)}s`
              : (String(stderr || err.message).split("\n").filter(Boolean).pop() || "ffmpeg failed").slice(0, 400),
          });
        }
        res({ ok: true, path: plan.outPath, width: plan.width, height: plan.height,
              fps: plan.fps, clips: plan.clipCount, name: basename(plan.outPath) });
      });
  });
}
