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
import { readFileSync } from "node:fs";

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
