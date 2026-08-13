// src/repos.mjs — every codebase Grayson has, as a thing Cleetus already knows.
//
// WHY THIS EXISTS
// Asked "can you access my github repos", Cleetus called check_access, listed
// ~/cleetus-memory/code (which is not a thing), and then reached for
//
//     find ~ -name "*.g...
//
// an unbounded walk of the entire home directory — through iCloud, through
// every node_modules on the disk — to answer a question whose answer is a
// twenty-line list. He had the shell and no map, so he went looking.
//
// The fix is not a better prompt. It is that the map should already be in his
// hand: the repos are a FACT about this machine, they change on the order of
// once a week, and reciting them costs nothing. So this builds the roster once,
// caches it, and agent.mjs injects a compact version into every system prompt.
// The tools below are for when he needs more than the roster.
//
// TWO KINDS OF REPO, AND THEY ARE NOT THE SAME QUESTION
//   local   a working tree on this disk. He can read, edit and commit in it.
//   remote  a repository on the GitHub account. If there is no local clone he
//           cannot touch a file in it until he clones it — and saying "yes I
//           can see it" about one of those is the failure this distinction
//           exists to prevent.
// They are matched up by origin URL, so each entry says which it is, and the
// roster names the ones that exist only on GitHub as exactly that.

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";

const CACHE = join(CONFIG.memoryRoot, "repos.json");

// Rebuilt on demand rather than on a timer: a scan costs a couple of seconds
// and the answer is stable for days. Anything that MUTATES a repo (clone, new
// checkout) refreshes explicitly rather than waiting this out.
const TTL_MS = Number(process.env.CLEETUSD_REPO_TTL_MS || 6 * 60 * 60 * 1000);

function sh(cmd, { cwd = CONFIG.home, ms = 25_000 } = {}) {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", cmd], { cwd, timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || "").trim(),
        err: String(stderr || err?.message || "").trim(),
      }));
  });
}

/**
 * Where to look for working trees.
 *
 * BOUNDED, and the bound is the point. The unbounded `find ~` that started all
 * this is not slow by accident — it descends into ~/Library/Mobile Documents,
 * where every open() can block uncancellably on the iCloud provider (see
 * config.mjs), and into every node_modules on the disk, several of which hold
 * their own vendored .git directories.
 *
 * -prune rather than a grep -v afterwards: filtering the output still pays the
 * cost of the walk, which is the entire cost.
 */
const SCAN_ROOTS = [CONFIG.home, join(CONFIG.home, "Documents"), join(CONFIG.home, "Desktop")];
const PRUNE = ["node_modules", "Library", ".Trash", ".cache", "vendor", ".venv",
               "Pods", "DerivedData", ".next", "dist", "build"];

async function scanLocal() {
  const prune = PRUNE.map((d) => `-name ${JSON.stringify(d)}`).join(" -o ");
  const roots = SCAN_ROOTS.map((r) => JSON.stringify(r)).join(" ");
  const { out } = await sh(
    `/usr/bin/find ${roots} -maxdepth 4 \\( ${prune} \\) -prune -o -name .git -print 2>/dev/null`,
    { ms: 40_000 },
  );
  const dirs = [...new Set(out.split("\n").filter(Boolean).map((p) => p.replace(/\/\.git$/, "")))];

  const repos = [];
  for (const dir of dirs) {
    // One git call, not five. Each of these spawns a process and there are
    // twenty-five of them; five calls each is a hundred processes and four
    // seconds of nothing.
    const { ok, out: raw } = await sh(
      `git -C ${JSON.stringify(dir)} rev-parse --abbrev-ref HEAD 2>/dev/null; echo "|"; ` +
      `git -C ${JSON.stringify(dir)} remote get-url origin 2>/dev/null; echo "|"; ` +
      `git -C ${JSON.stringify(dir)} status --porcelain 2>/dev/null | wc -l; echo "|"; ` +
      `git -C ${JSON.stringify(dir)} log -1 --format='%cr%x09%s' 2>/dev/null`,
      { cwd: dir, ms: 12_000 },
    );
    if (!ok && !raw) continue;
    const [branch = "", origin = "", dirty = "0", last = ""] = raw.split("\n|\n").map((s) => s.trim());
    const [when = "", subject = ""] = last.split("\t");
    repos.push({
      name: dir.split("/").pop(),
      path: dir,
      branch,
      origin,
      slug: slugOf(origin),
      dirty: Number(dirty) || 0,
      last_commit: when ? `${when}: ${subject}` : "",
    });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/** owner/name out of any of the four URL shapes git remotes come in. */
export function slugOf(url) {
  const m = String(url || "").match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/i);
  return m ? m[1] : "";
}

async function scanGitHub() {
  const { ok, out, err } = await sh(
    `gh repo list --limit 200 --json nameWithOwner,description,isPrivate,url,updatedAt,defaultBranchRef 2>&1`,
    { ms: 30_000 },
  );
  if (!ok) {
    // A missing or unauthenticated gh is an ordinary state, not a fault, and it
    // has a one-line remedy. Said out loud so the model reports THAT rather
    // than concluding there are no repositories.
    return { error: /not found|command not found/i.test(out + err)
      ? "the gh CLI is not installed (brew install gh)"
      : /auth|login/i.test(out + err)
        ? "gh is installed but not logged in (gh auth login)"
        : (out || err).split("\n")[0].slice(0, 160), repos: [] };
  }
  try {
    return {
      error: null,
      repos: JSON.parse(out).map((r) => ({
        slug: r.nameWithOwner,
        url: r.url,
        private: !!r.isPrivate,
        description: r.description || "",
        default_branch: r.defaultBranchRef?.name || "",
        updated: r.updatedAt || "",
      })),
    };
  } catch (e) {
    return { error: `gh returned something unparseable: ${e.message}`, repos: [] };
  }
}

async function build() {
  const [local, gh] = await Promise.all([scanLocal(), scanGitHub()]);
  const bySlug = new Map(local.filter((r) => r.slug).map((r) => [r.slug.toLowerCase(), r]));

  for (const r of gh.repos) {
    const hit = bySlug.get(r.slug.toLowerCase());
    if (hit) {
      hit.github = r.slug;
      hit.private = r.private;
      hit.description = r.description;
      hit.cloned = true;
    }
  }
  // GitHub repositories with no working tree on this disk. Named separately
  // because "I can see it" and "I can edit it" are different answers.
  const uncloned = gh.repos.filter((r) => !bySlug.has(r.slug.toLowerCase()));

  return {
    built_at: new Date().toISOString(),
    github_account: (await sh(`gh api user --jq .login 2>/dev/null`, { ms: 12_000 })).out || null,
    github_error: gh.error,
    local,
    uncloned,
  };
}

let inflight = null;

/** The whole index. Cached on disk so a restart does not pay for a rescan. */
export async function repoIndex({ refresh = false } = {}) {
  if (!refresh) {
    const cached = await readFile(CACHE, "utf8").then(JSON.parse).catch(() => null);
    if (cached && Date.now() - Date.parse(cached.built_at) < TTL_MS) return cached;
  }
  // One scan at a time. Three chat turns arriving together used to start three
  // full disk walks, which is how a cheap index became the slowest thing in the
  // process.
  if (inflight) return inflight;
  inflight = build()
    .then(async (data) => {
      await mkdir(CONFIG.memoryRoot, { recursive: true });
      await writeFile(CACHE, JSON.stringify(data, null, 2), "utf8").catch(() => {});
      return data;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Resolve however Grayson said it — a name, a path, or owner/name. */
export async function findRepo(query) {
  const q = String(query || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!q) return null;
  const { local } = await repoIndex();
  return (
    local.find((r) => r.path.toLowerCase() === q) ||
    local.find((r) => r.name.toLowerCase() === q) ||
    local.find((r) => (r.github || r.slug || "").toLowerCase() === q) ||
    local.find((r) => (r.github || r.slug || "").toLowerCase().endsWith("/" + q)) ||
    local.find((r) => r.name.toLowerCase().includes(q)) ||
    null
  );
}

/**
 * The roster, as it goes into every system prompt.
 *
 * Deliberately one line per repo and nothing else. The full detail — dirty
 * files, commit subjects, descriptions — is what the tools are for; putting it
 * here would grow every prompt by several thousand characters to answer a
 * question nobody asked yet.
 */
export function rosterText(index) {
  if (!index) return "";
  const lines = [];
  if (index.github_account) lines.push(`GitHub account: ${index.github_account} (the gh CLI is logged in, so you can read issues, PRs and clone).`);
  else if (index.github_error) lines.push(`GitHub: ${index.github_error}`);

  if (index.local.length) {
    lines.push(`\nWorking trees on this Mac — you can read, edit, run and commit in every one of these:`);
    for (const r of index.local) {
      const bits = [r.path];
      if (r.branch) bits.push(`on ${r.branch}`);
      if (r.github) bits.push(r.github);
      if (r.dirty) bits.push(`${r.dirty} uncommitted`);
      lines.push(`- ${r.name} — ${bits.join(", ")}`);
    }
  }
  if (index.uncloned?.length) {
    lines.push(`\nOn GitHub but NOT cloned here. You can read these through the gh CLI, but there is no file on this disk to edit until you clone one with clone_repo:`);
    for (const r of index.uncloned) lines.push(`- ${r.slug}${r.description ? ` — ${r.description}` : ""}`);
  }
  return lines.join("\n");
}
