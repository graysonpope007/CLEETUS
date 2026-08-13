// src/tools/repos.mjs — working in Grayson's code, rather than looking for it.
//
// The roster is already in the system prompt (see repos.mjs and agent.mjs), so
// these are not for "what repos are there". They are for the next question:
// what is the state of one, what changed, and getting at the ones that live
// only on GitHub.
//
// `git` is deliberately NOT a tool. run_shell already runs git, in a specific
// directory, with the whole surface of the command available — a second, worse
// git that supports six subcommands would be a thing to keep in step for no
// gain. What was actually missing was knowing WHERE the repos are, and that is
// what repo_status and the roster supply. The one exception is clone_repo,
// because a clone changes the index and the index has to be told.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.mjs";
import { repoIndex, findRepo, rosterText } from "../repos.mjs";

function sh(cmd, { cwd = CONFIG.home, ms = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", cmd], { cwd, timeout: ms, killSignal: "SIGKILL", maxBuffer: 8_000_000 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || "").trim(),
        err: String(stderr || err?.message || "").trim(),
        timedOut: !!err?.killed,
      }));
  });
}

export const repoTools = {
  list_repos: {
    schema: {
      description:
        "List every codebase Grayson has: the git working trees on this Mac (which you can read, " +
        "edit and commit in) and the repositories on his GitHub account. Call this when he asks " +
        "what repos he has, whether you can reach his GitHub, or where a project lives. Do NOT " +
        "go hunting with find or search_files for a repository — this is the answer.",
      parameters: {
        type: "object",
        properties: {
          refresh: {
            type: "boolean",
            description: "Rescan the disk and GitHub instead of using the cached index. Use after cloning or creating a repo.",
          },
        },
      },
    },
    async run({ refresh }) {
      const index = await repoIndex({ refresh: !!refresh });
      const text = rosterText(index);
      return `${text}\n\n(Index built ${index.built_at}. ${index.local.length} working trees here, ` +
             `${index.uncloned.length} on GitHub only.)`;
    },
  },

  repo_status: {
    schema: {
      description:
        "The current state of one repository: branch, what is uncommitted, how far ahead or behind " +
        "the remote it is, and the recent commits. Use before offering to change anything in a repo, " +
        "and to answer 'what was I working on'.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repo name, path, or owner/name. e.g. cleetusv2, ~/cleetusd, graysonpope007/protocol" },
        },
        required: ["repo"],
      },
    },
    async run({ repo }) {
      const hit = await findRepo(repo);
      if (!hit) {
        const index = await repoIndex();
        const onGh = index.uncloned.find((r) => r.slug.toLowerCase().endsWith("/" + String(repo).toLowerCase())
                                             || r.slug.toLowerCase() === String(repo).toLowerCase());
        if (onGh) {
          return `${onGh.slug} exists on his GitHub but there is no clone of it on this Mac, so there ` +
                 `is no working tree to report on. Clone it with clone_repo first if he wants to work in it.`;
        }
        return `No repository called "${repo}" on this Mac or on his GitHub. Call list_repos to see what there is.`;
      }

      const q = JSON.stringify(hit.path);
      const { out } = await sh(
        `git -C ${q} status -sb 2>&1 | head -40; echo "---LOG---"; ` +
        `git -C ${q} log -8 --format='%h %cr  %s' 2>&1; echo "---STASH---"; ` +
        `git -C ${q} stash list 2>&1 | head -5`,
        { cwd: hit.path },
      );
      return `${hit.name} — ${hit.path}${hit.github ? ` (${hit.github})` : ""}\n\n${out}`;
    },
  },

  github: {
    schema: {
      description:
        "Run the GitHub CLI as Grayson: issues, pull requests, releases, workflow runs, the API. " +
        "Give the arguments WITHOUT the leading 'gh'. Examples: \"pr list --repo graysonpope007/protocol\", " +
        "\"issue view 12 --repo owner/name\", \"api user/repos --paginate --jq '.[].full_name'\", " +
        "\"run list --limit 5\". Use this rather than curl — it is already authenticated.",
      parameters: {
        type: "object",
        properties: {
          args: { type: "string", description: "Everything after 'gh'." },
          cwd: { type: "string", description: "Repo path to run inside, so --repo can be omitted." },
        },
        required: ["args"],
      },
    },
    async run({ args, cwd }) {
      let dir = CONFIG.home;
      if (cwd) {
        const hit = await findRepo(cwd);
        dir = hit ? hit.path : (existsSync(cwd) ? cwd : CONFIG.home);
      }
      // Passed through the shell rather than split here on purpose: --jq
      // expressions and JSON bodies are full of quoting that a naive split
      // destroys, and the model writes them the way it would type them.
      const r = await sh(`gh ${args}`, { cwd: dir, ms: 90_000 });
      const body = `${r.out}${r.err ? `\n[stderr]\n${r.err}` : ""}`.trim();
      if (r.timedOut) return `gh ${args} did not finish within 90s.\n${body}`.slice(0, 30_000);
      if (!body) return r.ok ? "(gh succeeded, no output)" : `gh ${args} failed with no output.`;
      return body.slice(0, 30_000);
    },
  },

  clone_repo: {
    schema: {
      description:
        "Clone one of Grayson's GitHub repositories onto this Mac so there is a working tree to edit. " +
        "Use when he asks you to work in a repo that list_repos says is on GitHub but not cloned here.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "owner/name, or just the name if it is his." },
          into: { type: "string", description: "Where to put it. Defaults to his home directory." },
        },
        required: ["repo"],
      },
    },
    async run({ repo, into }) {
      const index = await repoIndex();
      const wanted = String(repo).trim();
      const match = index.uncloned.find((r) => r.slug.toLowerCase() === wanted.toLowerCase())
                 || index.uncloned.find((r) => r.slug.toLowerCase().endsWith("/" + wanted.toLowerCase()));
      const already = await findRepo(wanted);
      if (already) return `Already cloned: ${already.path}. Nothing to do.`;

      const slug = match ? match.slug : wanted;
      if (!slug.includes("/")) {
        return `"${wanted}" is not one of his GitHub repositories and is not already on this disk. ` +
               `Call list_repos, or give the full owner/name.`;
      }
      const parent = into ? String(into).replace(/^~/, CONFIG.home) : CONFIG.home;
      const target = join(parent, slug.split("/")[1]);
      if (existsSync(target)) return `${target} already exists. Not overwriting it.`;

      const r = await sh(`gh repo clone ${JSON.stringify(slug)} ${JSON.stringify(target)} 2>&1`, { ms: 180_000 });
      // The index is now wrong, and a stale index is exactly the thing that
      // sends him hunting with find. Rebuild before answering.
      await repoIndex({ refresh: true }).catch(() => {});
      return r.ok
        ? `Cloned ${slug} to ${target}. It is in the index now, so you can read and edit it.`
        : `Could not clone ${slug}: ${r.out || r.err}`;
    },
  },
};
