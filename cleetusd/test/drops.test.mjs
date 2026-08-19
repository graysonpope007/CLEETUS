// test/drops.test.mjs — dropping a file on the chat, and the ways it could lie.
//
// This feature's failure mode is not a crash. It is an assistant that answers
// confidently about a file it never actually received: a scanned PDF with no
// text layer discussed as though it had been read, a truncated download
// described as a photograph, a three-minute video summarised from one frame.
// Every one of those produces a fluent, wrong answer that nobody can tell from
// a right one, which is exactly why they are the tests.
//
// So the assertions here are mostly about what is NOT claimed. A `vision` field
// present means "there is genuinely a picture to look at", `text` present means
// "words were genuinely extracted", and when neither is true the `note` has to
// say so in words the model will repeat rather than paper over.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { describe, attachmentLine, kindFor, safeName } from "../src/drops.mjs";

const serverSrc = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
const uiSrc = readFileSync(new URL("../src/ui.mjs", import.meta.url), "utf8");

async function tmp() {
  return mkdtemp(join(tmpdir(), "drops-"));
}

/** A real 4x4 PNG, made by sips rather than hand-rolled, so the bytes are honest. */
function realPng(dir) {
  const src = join(dir, "seed.txt");
  const dest = join(dir, "real.png");
  // sips needs an image to start from; the smallest honest one is a PNG we
  // write from a known-good base64 blob. This is a genuine 1x1 PNG.
  const ONE_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  execFileSync("/bin/sh", ["-c", `printf %s '${ONE_PIXEL}' | base64 -d > ${JSON.stringify(dest)}`]);
  void src;
  return dest;
}

// ── kind ──────────────────────────────────────────────────────────────────────

test("a file is classified by what it is, not only by what the browser called it", () => {
  assert.equal(kindFor("IMG_4821.HEIC"), "image");
  assert.equal(kindFor("clip.MOV"), "video");
  assert.equal(kindFor("contract.pdf"), "document");
  assert.equal(kindFor("books.csv"), "text");
  assert.equal(kindFor("archive.zip"), "other");
  // A browser that only supplies a mime type still gets sorted correctly.
  assert.equal(kindFor("noextension", "image/png"), "image");
  assert.equal(kindFor("noextension", "video/quicktime"), "video");
});

// ── names ─────────────────────────────────────────────────────────────────────

test("a dropped name cannot escape the drops folder", () => {
  // The property that actually matters is not "the string contains no dots".
  // It is that joining the result onto the folder still lands INSIDE the
  // folder — a name is a capability here, because the next thing that happens
  // to it is a write. `report..final.png` is a perfectly ordinary filename and
  // failing it would be a test asserting its own paraphrase instead of the rule.
  const root = "/tmp/drops-root";
  for (const bad of ["../../.ssh/id_rsa", "/etc/passwd", "..%2f..%2fx", "a/b/c.png",
                     "....//....//x", "\u0000boot", ".."]) {
    const landed = resolve(join(root, safeName(bad)));
    assert.ok(landed.startsWith(root + "/"), `${JSON.stringify(bad)} escaped to ${landed}`);
    assert.equal(dirname(landed), root, `${JSON.stringify(bad)} landed in a subdirectory: ${landed}`);
  }
});

test("four files dropped in the same second stay four files", () => {
  // The gesture is one drag. If the timestamp were the only thing making the
  // name unique, three of the four would overwrite each other and the loss
  // would be silent — the chips all appear, the paths all differ by nothing.
  const names = new Set([
    safeName("shot.png"), safeName("shot.png"), safeName("shot.png"), safeName("shot.png"),
  ]);
  assert.equal(names.size, 4);
});

// ── what is and is not claimed ────────────────────────────────────────────────

test("a file named like an image but not one gets NO eyes and says why", async () => {
  const dir = await tmp();
  const bad = join(dir, "fake.png");
  await writeFile(bad, "this is not an image at all");
  const d = await describe(bad);

  // The bug this replaced: the bytes were sent to the vision model anyway, and
  // a vision model handed 27 bytes of ASCII does not report nonsense — it
  // describes something. Fluent and about nothing is worse than silent.
  assert.equal(d.vision, null, "27 bytes of text were offered to the vision model as a picture");
  assert.ok(d.note, "no eyes and no explanation");
  assert.match(d.note, /not actually an image|cannot decode|decode it as one/i);
  assert.match(d.note, /do not describe/i, "the note has to forbid describing it, not just mention a problem");
});

test("a real image gets eyes", async function (t) {
  if (!existsSync("/usr/bin/sips")) return t.skip("sips is macOS only");
  const dir = await tmp();
  const d = await describe(realPng(dir));
  assert.equal(d.kind, "image");
  assert.ok(d.vision && d.vision.length > 100, "a genuine PNG came back with nothing to look at");
  // What comes back must be a JPEG, because that is what the message claims
  // it is. A base64 blob with the wrong header is the same silent lie as above.
  const head = Buffer.from(d.vision, "base64");
  assert.equal(head[0], 0xff);
  assert.equal(head[1], 0xd8, "the vision payload is not a JPEG");
});

test("an empty text file is reported empty rather than read as nothing", async () => {
  const dir = await tmp();
  const f = join(dir, "notes.md");
  await writeFile(f, "");
  const d = await describe(f);
  assert.ok(d.note, "an empty file passed as a document with content");
  assert.match(d.note, /empty/i);
});

test("a text file's words are inlined and the path still goes with them", async () => {
  const dir = await tmp();
  const f = join(dir, "books.csv");
  await writeFile(f, "name,amount\nMagnolia,1200\n");
  const d = await describe(f);
  assert.match(d.text, /Magnolia,1200/);
  const line = attachmentLine(d);
  assert.ok(line.includes(f), "the sentence dropped the path, so nothing can read more of it later");
  assert.match(line, /Magnolia,1200/);
});

test("a long document is truncated OUT LOUD, with the path to the rest", async () => {
  const dir = await tmp();
  const f = join(dir, "long.txt");
  await writeFile(f, "x".repeat(80_000));
  const d = await describe(f);
  assert.ok(d.text.length < 80_000, "the whole file went into the context");
  assert.match(d.text, /truncated/i, "it was cut without saying so, which reads as a short document");
  assert.ok(d.text.includes(f), "truncated with no way to get the rest");
});

// ── video ─────────────────────────────────────────────────────────────────────

test("a video's frame is never described as the video", async function (t) {
  const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => existsSync(p));
  if (!ffmpeg) return t.skip("ffmpeg is not on this machine");
  const dir = await tmp();
  const mp4 = join(dir, "clip.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
    "-t", "3", "-pix_fmt", "yuv420p", mp4]);

  const d = await describe(mp4);
  assert.equal(d.kind, "video");
  assert.equal(d.width, 320);
  assert.ok(d.seconds >= 2.5 && d.seconds <= 3.5, `duration read as ${d.seconds}`);
  assert.ok(d.vision, "no frame was pulled out, so the clip is invisible");

  // The whole point. One frame is not the clip, and an assistant that says
  // "in your video, X happens" off a single still is making it up.
  const line = attachmentLine(d);
  assert.match(line, /single frame/i);
  assert.match(line, /do not claim to have watched/i);
});

// ── the wiring, which is where a working module goes unused ───────────────────

test("the upload route is reachable the same two ways the chat is", () => {
  // The deck is a browser on this Mac and cannot attach an Authorization
  // header to anything, so /upload has to be on the local-browser list or
  // every drop comes back 401. Being on that list adds a door rather than
  // closing one: a phone over the tunnel still gets in with a token, which is
  // the only way a photo ever leaves a phone.
  const routes = serverSrc.slice(serverSrc.indexOf("const BROWSER_ROUTES"),
                                serverSrc.indexOf("const localBrowser"));
  assert.match(routes, /"\/upload"/, "/upload is not on the local-browser list, so the deck gets a 401");
  assert.match(routes, /"\/chat\/stream"/, "the comparison this rests on no longer holds");

  // The cursor routes are the ones that genuinely refuse a valid token, and
  // an upload must never quietly join them — that would break the phone.
  assert.ok(!/CURSOR_ROUTES = \[[^\]]*upload/s.test(serverSrc));
  assert.match(serverSrc, /url\.pathname === "\/upload" && req\.method === "POST"/);
});

test("the deck actually sends what was dropped", () => {
  // Every previous version of this feature that quietly did nothing did it
  // here: the chips rendered, the upload succeeded, and the composer posted
  // the typed text alone.
  assert.match(uiSrc, /const ATTACH = \[\]/, "the deck has no attachment list");
  assert.match(uiSrc, /fetch\('\/upload'/, "the deck never uploads");
  assert.match(uiSrc, /files\.map\(f => f\.line\)/, "the file's sentence never reaches the message");
  assert.match(uiSrc, /type: 'image', source:/, "a dropped picture never becomes an image block");
  assert.match(uiSrc, /a\.state === 'ok'/, "a failed upload would be sent as though it worked");
});

test("the drop overlay cannot swallow the drop", () => {
  // An overlay that takes pointer events is an overlay that eats the event it
  // exists to advertise, and the page then looks like it does nothing at all.
  const veil = uiSrc.slice(uiSrc.indexOf(".dropveil{"), uiSrc.indexOf(".dropveil.on"));
  assert.match(veil, /pointer-events:none/);
});
