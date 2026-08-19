// test/refs.test.mjs — the pictures that say what something is supposed to look like.
//
// generate_image can start from a reference, which is the strongest lever there
// is on whether a picture matches what he had in mind. That left a hole: the
// agent could USE one and had no idea where to find one. The brief's answer was
// "find_files for existing logo and artwork assets on disk" — an unbounded
// search of his home directory, which is the exact flailing the repo roster was
// added to stop, wearing a different hat.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const mediaSrc = readFileSync(new URL("../src/tools/media.mjs", import.meta.url), "utf8");

async function withRefs(build) {
  const root = await mkdtemp(join(tmpdir(), "refs-"));
  await build(root);
  process.env.CLEETUSD_REFS_DIR = root;
  // Imported fresh each time so the env override is read at module load.
  const mod = await import(`../src/refs.mjs?${Math.random()}`);
  return { root, ...mod };
}

test("a set is named by its folder, newest picture first", async () => {
  const { listReferences } = await withRefs(async (root) => {
    await mkdir(join(root, "glm"), { recursive: true });
    await writeFile(join(root, "glm", "older.png"), "x");
    await new Promise((r) => setTimeout(r, 12));
    await writeFile(join(root, "glm", "newest.jpg"), "x");
  });
  const sets = await listReferences();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].set, "glm");
  // The most recent artwork for a brand is almost always what defines it now.
  assert.equal(sets[0].pictures[0].name, "newest.jpg");
});

test("a file a sampler cannot open is counted, not offered", async () => {
  // A PDF brand guide is a reasonable thing for him to keep in here. Silently
  // ignoring it would leave a folder that looks empty for no stated reason;
  // offering it as a reference would fail inside img2img.
  const { listReferences, referencesText } = await withRefs(async (root) => {
    await mkdir(join(root, "magnolia"), { recursive: true });
    await writeFile(join(root, "magnolia", "brand.pdf"), "x");
  });
  const sets = await listReferences();
  assert.equal(sets[0].pictures.length, 0);
  assert.equal(sets[0].others, 1);
  assert.match(referencesText(sets), /cannot be a reference/);
});

test("the empty case tells him how to make one", async () => {
  // The whole feature is worthless if he never learns the folder exists, and
  // this is the moment the agent has his attention.
  const { listReferences, referencesText } = await withRefs(async () => {});
  const text = referencesText(await listReferences());
  assert.match(text, /no reference sets yet/i);
  assert.match(text, /creating a folder/i);
  assert.match(text, /ask him for two or three/i);
});

test("the listing gives PATHS, not names to resolve", () => {
  // The next thing the agent does with one is pass it to generate_image as
  // `reference`. A name it has to resolve is a name it will resolve wrongly.
  const src = readFileSync(new URL("../src/refs.mjs", import.meta.url), "utf8");
  assert.match(src, /\$\{p\.path\}/);
});

test("the tool exists and tells it to stop searching the disk", () => {
  assert.match(mediaSrc, /list_references: \{/);
  assert.match(mediaSrc, /Do not go hunting the disk with find_files/);
  assert.match(mediaSrc, /CALL THIS BEFORE generating anything for one of his brands/);
});

test("nothing is chosen automatically", () => {
  // Silently starting every GLM request from whatever happens to be first in a
  // folder is the kind of helpfulness that becomes impossible to debug: the
  // picture looks like something and there is no trace of why.
  const src = readFileSync(new URL("../src/refs.mjs", import.meta.url), "utf8");
  assert.match(src, /DELIBERATELY NOT AUTOMATIC/);
  assert.match(mediaSrc, /and SAY which picture you started from/);
});

test("it is told never to pass off an existing file as one it just made", async () => {
  /* Caught in a benchmark run, and the run file records it verbatim. The
     sampler was stubbed and returned a path that was not where the agent
     expected, so it went looking with the shell and ran:

         cp ~/cleetusd/media/out/img_20260819044236.png \
            ~/cleetusd/media/glm-single-cover-v1.png

     An unrelated picture Grayson had generated hours earlier, copied under a
     name derived from the request, and handed back as the cover it had just
     made.

     The stub provoked it and the behaviour is not the stub's: whenever a path
     is missing or unexpected, "find a picture and rename it" is available and
     looks exactly like success. It is the same fault as claiming an image
     exists before the tool returns, one step further along — the file is real,
     and the claim about where it came from is not. */
  const { AGENTS } = await import("../src/agents.mjs");
  const brief = AGENTS.image.brief;
  assert.match(brief, /NEVER present a file you did not just generate/);
  assert.match(brief, /do not copy, rename or go hunting the disk/);
  // And the honest alternative has to be named, or the rule is just a
  // prohibition with no branch to take.
  assert.match(brief, /say that plainly/);
});

test("a set name cannot become a path", async () => {
  /* The set name comes from HIS words — "save this for GLM" — and becomes a
     folder. That makes it a capability, the same as a dropped filename, and it
     gets the same treatment: reduce it to plain name characters rather than
     try to detect traversal cleverly. A clever sanitiser is a thing that gets
     outsmarted; a whitelist is not. */
  const { safeSetName } = await import("../src/refs.mjs");
  for (const evil of ["../../.ssh", "/etc", "a/../../b", "glm/../../../tmp", "....//....//x"]) {
    const n = safeSetName(evil);
    assert.ok(!n.includes("/"), `${evil} kept a separator: ${n}`);
    assert.ok(!n.includes(".."), `${evil} kept a dot segment: ${n}`);
    assert.ok(!n.startsWith("-") && !n.endsWith("-"), `${evil} produced ${n}`);
  }
  // And a name that reduces to nothing is refused rather than silently made up.
  assert.equal(safeSetName(".."), "");
  assert.equal(safeSetName("!!!"), "");
});

test("filing a picture COPIES it, and never overwrites one already there", async () => {
  /* Copy, because the drops folder is the record of what he sent: moving would
     mean filing a picture silently removes it from the conversation it arrived
     in, while the answer he already read still names the old path.

     And never overwrite, because the picture already in a set is one he chose
     and the new one is only the newest. */
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "refsave-"));
  process.env.CLEETUSD_REFS_DIR = join(root, "refs");
  const { saveReference } = await import(`../src/refs.mjs?${Math.random()}`);

  const src = join(root, "cover.png");
  await writeFile(src, "x");

  const a = await saveReference(src, "GLM");
  assert.ok(a.ok, a.error);
  assert.equal(a.set, "glm");
  assert.ok(existsSync(src), "the source was moved rather than copied");

  const b = await saveReference(src, "glm");
  assert.ok(b.ok);
  assert.notEqual(b.path, a.path, "the second save overwrote the first");
  assert.ok(existsSync(a.path), "the picture he already had was replaced");
});

test("a file a sampler cannot open is refused with the reason", async () => {
  const { saveReference } = await import("../src/refs.mjs");
  const r = await saveReference("/etc/hosts", "glm");
  assert.equal(r.ok, false);
  assert.match(r.error, /png, jpg, jpeg or webp/);
});

test("the tool tells it to ASK when he has not said to keep something", () => {
  // A reference he has to re-send every time is one he stops sending, and the
  // moment he has shown a good picture is the moment to offer.
  assert.match(mediaSrc, /save_reference: \{/);
  assert.match(mediaSrc, /ASK whether he wants it saved/);
  assert.match(mediaSrc, /It COPIES/);
});
