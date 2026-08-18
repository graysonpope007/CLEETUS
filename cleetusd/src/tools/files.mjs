// src/tools/files.mjs — the machine itself.
//
// Full read and write across the disk, plus a shell. That was the explicit
// instruction: he is on this computer so that he can actually pick up whatever
// Grayson is working on, and a file tool with an allowlist cannot do that —
// the next project always lives in the directory nobody thought to list.
//
// What replaces a restriction is a RECORD. Every call here is written into the
// run file in the vault as it happens, so there is a readable trail of what he
// touched. CLEETUSD_NO_SHELL=1 takes the shell away without muting him.
//
// Two engineering guards, neither of them a permission check:
//   - reads are truncated, so one `read_file` on a 60MB log cannot blow the
//     context window and silently truncate the conversation instead.
//   - the shell has a timeout and a captured buffer, so a command that hangs
//     stalls one tool call rather than the daemon.

import { readFile, writeFile, mkdir, readdir, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.mjs";

const run = promisify(execFile);

const MAX_READ = 120_000;      // characters returned to the model
const SHELL_TIMEOUT = 120_000; // ms
const MAX_SHELL_OUT = 30_000;

/** ~ and relative paths both resolve against home, so the model can be sloppy. */
function realPath(p) {
  let s = String(p || "").trim();
  if (s.startsWith("~")) s = join(CONFIG.home, s.slice(1));
  return resolve(s.startsWith("/") ? s : join(CONFIG.home, s));
}

export const fileTools = {
  read_file: {
    schema: {
      description: "Read a file from Grayson's Mac. Returns its text. Use before editing anything.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path, or ~/relative." },
          start_line: { type: "number", description: "Optional 1-indexed first line." },
          max_lines: { type: "number", description: "Optional line count to return." },
        },
        required: ["path"],
      },
    },
    async run({ path, start_line, max_lines }) {
      const p = realPath(path);
      if (!existsSync(p)) return `No such file: ${p}`;
      const info = await stat(p);
      if (info.isDirectory()) return `${p} is a directory. Use list_dir.`;
      let text = await readFile(p, "utf8");
      if (start_line || max_lines) {
        const lines = text.split("\n");
        const from = Math.max(0, (start_line || 1) - 1);
        text = lines.slice(from, from + (max_lines || 200)).join("\n");
      }
      if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + `\n\n[truncated at ${MAX_READ} chars of ${info.size} bytes]`;
      return text || "(empty file)";
    },
  },

  write_file: {
    schema: {
      description: "Write a file, creating parent directories as needed. Overwrites. Read it first if it already exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    async run({ path, content }) {
      const p = realPath(path);
      await mkdir(dirname(p), { recursive: true });
      // A backup costs nothing next to losing something he did not have in git.
      if (existsSync(p)) {
        await rename(p, `${p}.bak`).catch(() => {});
      }
      await writeFile(p, String(content ?? ""), "utf8");
      return `Wrote ${p} (${String(content ?? "").length} chars)${existsSync(`${p}.bak`) ? ", previous version kept as .bak" : ""}`;
    },
  },

  edit_file: {
    schema: {
      description: "Replace an exact string in a file. Safer than write_file for a small change: it fails loudly rather than silently rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string", description: "Exact text to replace. Must appear exactly once." },
          replace: { type: "string" },
        },
        required: ["path", "find", "replace"],
      },
    },
    async run({ path, find, replace }) {
      const p = realPath(path);
      if (!existsSync(p)) return `No such file: ${p}`;
      const text = await readFile(p, "utf8");
      const count = text.split(find).length - 1;
      if (count === 0) return `Not found in ${p}. Read the file and match the text exactly, including indentation.`;
      if (count > 1) return `Found ${count} times in ${p}. Include more surrounding text so the match is unique.`;
      await writeFile(p, text.replace(find, replace), "utf8");
      return `Edited ${p}`;
    },
  },

  list_dir: {
    schema: {
      description: "List a directory. Use this to orient before reading.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run({ path }) {
      const p = realPath(path);
      if (!existsSync(p)) return `No such directory: ${p}`;
      const entries = await readdir(p, { withFileTypes: true });
      if (!entries.length) return `${p} is empty`;
      return entries
        .filter((e) => !e.name.startsWith(".DS"))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n")
        .slice(0, 8000);
    },
  },

  search_files: {
    schema: {
      description: "Search file CONTENTS across a directory tree with ripgrep. Use this to find where something lives when you do not know the filename.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regex to find." },
          path: { type: "string", description: "Directory to search. Defaults to home." },
          glob: { type: "string", description: "Optional filter, e.g. *.js" },
        },
        required: ["query"],
      },
    },
    async run({ query, path, glob }) {
      const dir = realPath(path || CONFIG.home);
      const args = ["--line-number", "--no-heading", "--color=never", "--max-count=6", "--max-filesize=2M", "-i"];
      if (glob) args.push("--glob", glob);
      args.push("--", String(query), dir);
      const trim = (s) => (s || "").split("\n").slice(0, 120).join("\n").trim();
      try {
        const { stdout } = await run("rg", args, { timeout: 30_000, maxBuffer: 4_000_000 });
        return trim(stdout) || `No matches for "${query}" under ${dir}`;
      } catch (e) {
        // rg's exit codes: 0 found something, 1 found nothing, 2 SOMETHING WENT
        // WRONG — and 2 does not mean the search failed. rg exits 2 if it could
        // not read a single file, even when it matched a hundred others, and it
        // still prints those matches on stdout.
        //
        // Throwing them away is not hypothetical: one unreadable iCloud
        // placeholder in the Obsidian vault is enough, and the whole search
        // came back "search failed" with real matches sitting in the buffer
        // that got discarded. A partial answer clearly labelled as partial
        // beats a total failure that is not even true.
        if (e.code === 1) return `No matches for "${query}" under ${dir}`;
        const found = trim(e.stdout);
        if (found) {
          const why = (e.stderr || "").split("\n").find((l) => l.trim()) || "some files could not be read";
          return `${found}\n\n(partial: ${why.trim()})`;
        }
        // ripgrep is not installed on this machine.
        //
        // `rg` resolves in an interactive shell here because it is a FUNCTION
        // the terminal provides, not a binary on PATH — so it works when a
        // human types it and fails with ENOENT the moment anything spawns it.
        // A particularly good disguise: the tool looks present from every angle
        // a person would check it from.
        //
        // grep is in the base system and cannot go missing. Slower, and without
        // the smart-case and gitignore handling, but a slower search that runs
        // beats a faster one that is not there.
        if (e.code === "ENOENT") {
          const gargs = ["-rn", "--binary-files=without-match", "-m", "6"];
          if (glob) gargs.push("--include", glob);
          gargs.push("-e", String(query), dir);
          try {
            const { stdout } = await run("grep", gargs, { timeout: 30_000, maxBuffer: 4_000_000 });
            return trim(stdout) || `No matches for "${query}" under ${dir}`;
          } catch (g) {
            if (g.code === 1) return `No matches for "${query}" under ${dir}`;
            const partial = trim(g.stdout);
            if (partial) return `${partial}\n\n(partial: ${(g.stderr || "").split("\n")[0] || "some files unreadable"})`;
            return `search failed: ${g.stderr?.trim() || g.message}`;
          }
        }
        return `search failed: ${e.stderr?.trim() || e.message}`;
      }
    },
  },

  find_files: {
    schema: {
      description: "Find files by NAME pattern. Use when you know roughly what a file is called but not where it is.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Glob, e.g. *.env or cleetus*" },
          path: { type: "string" },
        },
        required: ["name"],
      },
    },
    async run({ name, path }) {
      const dir = realPath(path || CONFIG.home);
      try {
        const { stdout } = await run("rg", ["--files", "--glob", String(name), dir], { timeout: 30_000, maxBuffer: 4_000_000 });
        return stdout.split("\n").slice(0, 100).join("\n").trim() || `Nothing named like "${name}" under ${dir}`;
      } catch (e) {
        if (e.code === 1) return `Nothing named like "${name}" under ${dir}`;
        // Same missing binary as search_files. `find` is POSIX and always here.
        // -name takes the same glob shapes callers already pass, and the noise
        // from unreadable directories goes to stderr, so a partial answer still
        // comes back on stdout rather than the whole thing failing.
        if (e.code === "ENOENT") {
          try {
            const { stdout } = await run("find", [dir, "-name", String(name)], { timeout: 30_000, maxBuffer: 4_000_000 });
            return stdout.split("\n").slice(0, 100).join("\n").trim() || `Nothing named like "${name}" under ${dir}`;
          } catch (f) {
            const partial = (f.stdout || "").split("\n").slice(0, 100).join("\n").trim();
            if (partial) return `${partial}\n\n(partial: some directories could not be read)`;
            return `find failed: ${f.stderr?.trim() || f.message}`;
          }
        }
        return `find failed: ${e.message}`;
      }
    },
  },

  run_shell: {
    schema: {
      description: "Run a shell command on Grayson's Mac and return its output. Use for git, npm, builds, curl, anything the other tools do not cover.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Directory to run in. Defaults to home." },
        },
        required: ["command"],
      },
    },
    async run({ command, cwd }) {
      if (!CONFIG.shellEnabled) return "The shell is switched off right now (CLEETUSD_NO_SHELL=1). Everything else still works.";
      const dir = realPath(cwd || CONFIG.home);
      try {
        const { stdout, stderr } = await run("/bin/zsh", ["-lc", String(command)], {
          cwd: dir,
          timeout: SHELL_TIMEOUT,
          maxBuffer: 10_000_000,
        });
        const out = `${stdout || ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
        return (out || "(no output, exit 0)").slice(0, MAX_SHELL_OUT);
      } catch (e) {
        const out = `${e.stdout || ""}${e.stderr || ""}`.trim();
        return `exit ${e.code ?? "?"}${e.killed ? " (timed out)" : ""}\n${out}`.slice(0, MAX_SHELL_OUT);
      }
    },
  },
};
