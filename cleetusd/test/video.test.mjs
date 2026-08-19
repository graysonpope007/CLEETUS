// test/video.test.mjs — every video this file ever made was square, and squashed.
//
// The still path got a week of attention. Video got none, and it had the worst
// bug of the lot sitting in it the whole time:
//
//     zoom = "...:s=1024x1024:fps=30"
//     "-vf", "scale=2048:2048,{zoom},format=yuv420p"
//
// Neither of those preserves aspect. Measured with a real render: an 832x1216
// portrait keyframe came out a 1024x1024 video. That is not a crop. The whole
// picture is SQUASHED — every face and every proportion in it wrong — and it
// happened silently on every clip ever produced.
//
// It also meant a 9:16 story and a 16:9 hero were impossible to make whatever
// --aspect said, because the aspect only ever reached the keyframe and the
// render threw it away again. media_cli had accepted --aspect for video the
// entire time; the tool never offered it, so nothing could pass one.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = readFileSync(join(ROOT, "media_cli.py"), "utf8");
const mediaSrc = readFileSync(join(ROOT, "src/tools/media.mjs"), "utf8");
const PY = process.env.CLEETUSD_MEDIA_PYTHON || join(ROOT, "media/.venv/bin/python");
const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => existsSync(p));
const ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].find((p) => existsSync(p));

// ── the squash ────────────────────────────────────────────────────────────────

test("nothing in the motion render is a hardcoded square any more", () => {
  const fn = cli.slice(cli.indexOf("def _video_motion"), cli.indexOf("def _video_svd"));
  // Comments stripped first. The note above the fix quotes the old
  // `scale=2048:2048` and `s=1024x1024` deliberately — that is the record of
  // what was wrong and why, and it is worth more than the convenience of a
  // regex that can be run over the raw file. A test that forces the
  // explanation to be deleted is a test making the codebase worse.
  const code = fn.split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");
  assert.ok(!/s=1024x1024/.test(code), "the output size is still pinned to a square");
  assert.ok(!/scale=2048:2048/.test(code), "the pre-scale is still pinned to a square");
  assert.match(fn, /kw, kh = _image_size\(keyframe\)/,
    "the render does not read the keyframe's real size");
  // h264 refuses an odd dimension outright, and a keyframe is not guaranteed even.
  assert.match(fn, /kw - \(kw % 2\), kh - \(kh % 2\)/,
    "an odd keyframe dimension would fail the encode");
});

test("a portrait keyframe makes a portrait video", { skip: (!ffmpeg || !ffprobe) && "ffmpeg is not on this machine" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vid-"));
  const key = join(dir, "tall.png");
  const mp4 = join(dir, "out.mp4");

  // A real 832x1216 still, the shape realvis renders a person at.
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi",
    "-i", "testsrc=size=832x1216:rate=1", "-frames:v", "1", key]);
  execFileSync(PY, [join(ROOT, "media_cli.py"), "video", "--image", key,
    "--mode", "motion", "--seconds", "1", "--out", mp4], { encoding: "utf8", stdio: "pipe" });

  const dims = execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4], { encoding: "utf8" }).trim();
  assert.equal(dims, "832,1216",
    `a portrait keyframe rendered ${dims} — squashed, as it was before the fix`);
});

// ── the shape could not be asked for ─────────────────────────────────────────

test("the video tool offers a shape and an exclusion at all", () => {
  // media_cli has taken --aspect and --negative for video the whole time. The
  // tool offered neither, so the model had no way to pass one and every clip
  // took the default.
  const fn = mediaSrc.slice(mediaSrc.indexOf("generate_video: {"));
  assert.match(fn, /aspect: \{ type: "string", enum: \["square", "portrait", "tall", "landscape", "wide"\]/);
  assert.match(fn, /negative: \{ type: "string"/);
  assert.match(fn, /args\.push\("--aspect", String\(aspectUsed\)\)/, "aspect never reaches media_cli");
  assert.match(fn, /args\.push\("--negative", String\(negativeUsed\)\)/, "negative never reaches media_cli");
});

test("a clip gets the same two guarantees a still does", () => {
  const fn = mediaSrc.slice(mediaSrc.indexOf("generate_video: {"));
  // A keyframe is an image made by the same sampler, so a negation puts the
  // thing in the frame exactly as it does for a photograph — and the video
  // then holds it for four seconds.
  assert.match(fn, /const lifted = liftNegations\(String\(prompt \|\| ""\)\)/);
  // The parts, not the punctuation: inference must be skipped when he named a
  // shape AND when he is animating a picture whose shape is already decided.
  const shapeLine = fn.slice(fn.indexOf("const shape ="), fn.indexOf("const aspectUsed"));
  assert.match(shapeLine, /!aspect/, "his explicit aspect no longer wins");
  assert.match(shapeLine, /!image/,
    "inference runs even when animating a picture whose shape is already decided");
  assert.match(shapeLine, /inferAspect\(promptUsed\)/);
  assert.match(fn, /He set no shape, so it was made/, "choosing the shape for him is not said");
});

test("the clip reports the size it actually is", () => {
  // It used to report seconds and fps and nothing about the frame, which is
  // how a square video went unnoticed for as long as it did.
  assert.match(cli, /"width": kw, "height": kh,/);
  assert.match(mediaSrc, /r\.width && r\.height \? ` at \$\{r\.width\}x\$\{r\.height\}`/);
});
