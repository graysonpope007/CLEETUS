// test/pushrevert.test.mjs — the safety net's own failure mode.
//
// Pushing the fix and pushing the revert are not the same risk. A rejected FIX
// push means nothing shipped: safe. A rejected REVERT push means the bad commit
// is already live and stays there.
//
// Reproduced in a scratch repo before this existed: our commit lands, another
// session pushes on top, and the revert push is refused as a non-fast-forward
// while the bad change stays live. `sh` rejects on non-zero exit, so it threw
// out of the loop — no history entry, no "reverted" outcome, just an error, with
// production still broken. That window is the whole deploy wait, and there IS
// another session pushing to this repo.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd, cmd) => execFileSync("/bin/zsh", ["-lc", cmd], { cwd, encoding: "utf8" });

function lab() {
  const root = mkdtempSync(join(tmpdir(), "revertlab-"));
  const remote = join(root, "remote"), work = join(root, "work"), other = join(root, "other");
  execFileSync("/bin/zsh", ["-lc", `mkdir -p ${remote} ${work} ${other} && cd ${remote} && git init -q --bare -b main`]);
  git(work, `git init -q -b main . && git remote add origin ${remote} && git config user.email a@a && git config user.name a`);
  writeFileSync(join(work, "f.txt"), "base\n");
  git(work, "git add -A && git commit -qm base && git push -q origin main");
  git(other, `git clone -q ${remote} . && git config user.email b@b && git config user.name b`);
  return { root, remote, work, other };
}

test("git revert --no-edit undoes the change (the happy path)", () => {
  const { root, work } = lab();
  try {
    writeFileSync(join(work, "f.txt"), "bad\n");
    git(work, 'git commit -qam "Cleetus: a bad fix" && git push -q origin main');
    const sha = git(work, "git rev-parse HEAD").trim();
    git(work, `git revert --no-edit ${sha} && git push -q origin main`);
    assert.strictEqual(readFileSync(join(work, "f.txt"), "utf8"), "base\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rejected FIX push ships nothing — the safe failure", () => {
  const { root, work, other, remote } = lab();
  try {
    git(other, 'git pull -q && echo theirs > g.txt && git add -A && git commit -qm other && git push -q origin main');
    writeFileSync(join(work, "f.txt"), "bad\n");
    git(work, 'git commit -qam "Cleetus: fix"');
    assert.throws(() => git(work, "git push -q origin main"), /.*/, "push should be refused");
    assert.strictEqual(git(remote, "git log --oneline").includes("Cleetus"), false, "nothing of ours reached main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rejected REVERT push leaves the bad commit live — unless rebased", () => {
  const { root, work, other, remote } = lab();
  try {
    // 1. our bad fix goes live
    writeFileSync(join(work, "f.txt"), "bad\n");
    git(work, 'git commit -qam "Cleetus: bad fix" && git push -q origin main');
    const sha = git(work, "git rev-parse HEAD").trim();
    // 2. another session pushes on top, during the deploy wait
    git(other, 'git pull -q && echo theirs > g.txt && git add -A && git commit -qm other && git push -q origin main');
    // 3. we revert locally and try to push
    git(work, `git revert --no-edit ${sha}`);
    assert.throws(() => git(work, "git push -q origin main"), /.*/, "the revert push is refused");
    assert.match(git(other, "git pull -q; cat f.txt"), /bad/, "the bad change is STILL LIVE at this point");

    // 4. what pushRevert does about it
    git(work, "git pull -q --rebase origin main && git push -q origin main");
    assert.strictEqual(git(other, "git pull -q; cat f.txt").trim(), "base", "the revert landed");
    assert.match(git(remote, "git log --oneline"), /other/, "and the other session's commit survived");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the loop never reports a revert it did not land", () => {
  // The most dangerous sentence this loop could produce is "reverted" while the
  // change is still live. Both the history entry and the return value key off
  // whether the push actually succeeded.
  const src = readFileSync(new URL("../src/improve.mjs", import.meta.url), "utf8");
  assert.match(src, /outcome: undone \? "reverted" : "REVERT FAILED/);
  assert.match(src, /revert_pushed: undone/);
  assert.ok(!/outcome: "reverted",/.test(src), "an unconditional 'reverted' outcome is back");
});
