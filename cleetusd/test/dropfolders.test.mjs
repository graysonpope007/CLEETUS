// test/dropfolders.test.mjs — a dropped FOLDER is read, all of it, every time.
//
// The bug this pins was invisible in the only place anyone looked. Dropping a
// folder of photos on a chat window produced "Failed to fetch", which reads as
// the daemon being down or the network being wrong; the daemon never saw the
// request. dataTransfer.files carries an entry for a dropped folder that has a
// name and a size and is indistinguishable from a file until you try to read
// its bytes, at which point the browser refuses and fetch reports the refusal
// as the same bare TypeError it reports a dead server with.
//
// So the page walks the folder instead. Two things about that walk are the
// difference between "reads the folder" and "reads some of the folder", and
// both fail silently, which is why they are tested here rather than trusted:
//
//   readEntries hands back AT MOST 100 entries per call. Called once, it
//   truncates every folder with more than a hundred things in it and reports
//   nothing — the chips all say "ready" and two thirds of the shoot is missing.
//
//   Subfolders have to be recursed, with their path kept, or forty files named
//   IMG_0001 arrive as forty identical chips.
//
// This runs the SHIPPED page source — the same text the browser is served —
// against a fake entry tree, rather than a paraphrase of it that can drift.

import { DASHBOARD } from "../src/ui.mjs";
import { displayName } from "../src/drops.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
};

// ── Lift the intake out of the page, DOM-free ────────────────────────────────
// From the attachment state down to the drag handlers: everything in that span
// is a declaration, so evaluating it touches no document. Sliced by landmark
// rather than by line number so an edit above or below cannot silently shift it.
const script = DASHBOARD.slice(DASHBOARD.indexOf("<script type=\"module\">"));
const from = script.indexOf("const ATTACH = [];");
const to = script.indexOf("/* The counter, rather than a plain dragleave handler.");
ok("the page still has an attachment intake to test", from > 0 && to > from,
   `from ${from} to ${to}`);

const intake = script.slice(from, to);
const load = new Function(intake + "\nreturn { gather, walk, JUNK, MAX_FILES };");
const { gather, MAX_FILES } = load();

// ── A fake folder, shaped like a real one ────────────────────────────────────
// 250 files at the top level is the case that matters: three readEntries calls,
// and a single call returns the first hundred and looks complete.
const file = (name) => ({
  isFile: true, isDirectory: false, name,
  file: (res) => res({ name, type: "image/png", size: 74 }),
});
const dir = (name, children) => ({
  isFile: false, isDirectory: true, name,
  createReader() {
    let i = 0;
    let calls = 0;
    return {
      calls: () => calls,
      readEntries(res) {
        calls++;
        // The real one caps each call at 100 and answers with an empty array
        // only when it is genuinely finished. Both halves are the trap.
        const batch = children.slice(i, i + 100);
        i += batch.length;
        setTimeout(() => res(batch), 0);
      },
    };
  },
});

const top = [];
for (let i = 1; i <= 250; i++) top.push(file("f" + i + ".png"));
top.push(file(".DS_Store"));
top.push(dir("sub", [
  ...Array.from({ length: 30 }, (_, i) => file("s" + (i + 1) + ".png")),
  dir("deep", Array.from({ length: 5 }, (_, i) => file("d" + (i + 1) + ".png"))),
]));

const got = await gather([dir("shoot", top)], []);
const names = got.map((g) => g.rel);

ok("every file under the folder came back, not the first hundred",
   got.length === 285, `${got.length} of 285`);
ok("a file three levels down is there, with its path",
   names.includes("shoot/sub/deep/d3.png"),
   names.filter((n) => /deep/.test(n)).join(",") || "none");
ok("the folder each file sat in is kept, so two IMG_0001 stay two things",
   names.includes("shoot/sub/s7.png") && names.includes("shoot/f7.png"));
ok("nothing came back twice", new Set(names).size === names.length);
ok(".DS_Store was left where it was", !names.some((n) => /DS_Store/.test(n)));
ok("every entry carries the actual File, not the folder handle",
   got.every((g) => g.file && g.file.name && !g.error));

// ── A drop with no entry API at all still works ──────────────────────────────
const flat = await gather([], [{ name: "loose.png" }, { name: ".DS_Store" }]);
ok("a browser without webkitGetAsEntry still gets its loose files",
   flat.length === 1 && flat[0].rel === "loose.png", JSON.stringify(flat.map((f) => f.rel)));

// ── One drop cannot start an unbounded number of uploads ─────────────────────
const huge = await gather([dir("everything",
  Array.from({ length: MAX_FILES + 50 }, (_, i) => file("x" + i + ".png")))], []);
ok("a mis-drop of something enormous stops", huge.length <= MAX_FILES + 1,
   String(huge.length));
ok("and SAYS it stopped rather than truncating quietly",
   huge.some((h) => h.error && /stopped at/.test(h.error)));

// ── The name that reaches the model keeps the folder, safely ─────────────────
ok("the relative path survives to the sentence Cleetus reads",
   displayName("shoot/day2/IMG_0001.HEIC") === "shoot/day2/IMG_0001.HEIC");
ok("a bare name is still a bare name", displayName("photo.png") === "photo.png");
ok("nothing shaped like an escape reaches a screen",
   !displayName("../../etc/passwd").includes("..") && !displayName("/a/b").startsWith("/"),
   displayName("../../etc/passwd") + " | " + displayName("/a/b"));
ok("an empty name still names something", displayName("") === "file");

// ── The page opens folders at all ────────────────────────────────────────────
// The property, not the spelling: there is exactly one API that walks a dropped
// folder, and a page that has stopped calling it has stopped reading folders.
ok("the deck asks the browser to open a dropped folder",
   /webkitGetAsEntry/.test(script));
ok("and the folder picker is still wired up",
   /webkitdirectory/.test(DASHBOARD) && /folderpicker/.test(script));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
