// src/coderui.mjs — how `cleetus` looks in a terminal. Pure functions, no I/O,
// so they can be tested without a TTY. Modelled on Claude Code: a welcome box,
// "⏺ Tool(args)" rows with a "⎿" result line, streamed markdown, a boxed input
// with a status line under it.

export const ESC = "\x1b[";
const on = { v: true };
export const setColor = (b) => { on.v = b; };
const sgr = (a, b = 0) => (s) => (on.v ? `${ESC}${a}m${s}${ESC}${b}m` : String(s));
export const dim = sgr("2", "22"), bold = sgr("1", "22"), ital = sgr("3", "23");
export const red = sgr("31", "39"), green = sgr("32", "39"), yellow = sgr("33", "39");
export const cyan = sgr("36", "39"), mag = sgr("35", "39"), gray = sgr("90", "39");
export const amber = sgr("38;5;215", "39"), blue = sgr("38;5;111", "39");
export const onRed = sgr("48;5;52", "49"), onGreen = sgr("48;5;22", "49"), onGray = sgr("48;5;236", "49");

export const strip = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
export const vis = (s) => [...strip(s)].length;
const pad = (s, w) => s + " ".repeat(Math.max(0, w - vis(s)));
const clip = (s, w) => { const t = strip(s); return t.length > w ? t.slice(0, Math.max(0, w - 1)) + "…" : s; };

/** A rounded box. Lines longer than the box are clipped, never wrapped. */
export function box(lines, { width = 60, color = gray, title = "" } = {}) {
  const inner = width - 4;
  const top = title ? `╭─ ${title} ${"─".repeat(Math.max(0, width - vis(title) - 5))}╮` : `╭${"─".repeat(width - 2)}╮`;
  return [color(top), ...lines.map((l) => color("│ ") + pad(clip(l, inner), inner) + color(" │")), color(`╰${"─".repeat(width - 2)}╯`)].join("\n");
}

/** Claude-style tool label: Read(src/x.mjs), Bash(npm test), Update(file). */
export function toolLabel(name, args = {}, show = (p) => p) {
  const one = (s, n = 70) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  switch (name) {
    case "read_file": return `Read(${show(args.path || "")}${args.offset ? `:${args.offset}` : ""})`;
    case "list_dir": return `List(${show(args.path || ".")})`;
    case "grep": return `Search(${one(args.pattern, 40)}${args.path ? ` in ${show(args.path)}` : ""})`;
    case "glob": return `Glob(${one(args.pattern, 50)})`;
    case "edit_file": return `Update(${show(args.path || "")})`;
    case "write_file": return `Write(${show(args.path || "")})`;
    case "bash": return `Bash(${one(args.command)})`;
    default: return `${name}(${one(Object.values(args).join(" "))})`;
  }
}

/** The one-line "⎿" summary under a tool row. */
export function toolSummary(name, result) {
  const r = String(result ?? "");
  const lines = r.split("\n");
  if (/^(Tool error|Unknown tool)/.test(r)) return { text: r.split("\n")[0].slice(0, 160), bad: true };
  if (/declined/.test(r) && r.length < 200) return { text: "Declined", bad: true };
  switch (name) {
    case "read_file": {
      if (/^No such file|is a directory/.test(r)) return { text: lines[0], bad: true };
      const n = lines.filter((l) => /^\s*\d+ {2}/.test(l)).length;
      return { text: `Read ${n} line${n === 1 ? "" : "s"}` };
    }
    case "list_dir": return { text: /^No such/.test(r) ? lines[0] : `${lines.length} entr${lines.length === 1 ? "y" : "ies"}`, bad: /^No such/.test(r) };
    case "grep": case "glob": {
      if (/^no (matches|files)/.test(r)) return { text: r.trim() };
      if (/failed:/.test(r)) return { text: lines[0], bad: true };
      return { text: `${lines.filter(Boolean).length} result${lines.filter(Boolean).length === 1 ? "" : "s"}` };
    }
    case "edit_file": case "write_file": return { text: lines[0], bad: !/^(Edited|Wrote)/.test(r) };
    case "bash": {
      const m = /^exit (\S+)/.exec(r);
      const body = lines.slice(1).filter((l) => l.trim());
      const code = m ? m[1] : "?";
      const tail = body.slice(-3).map((l) => l.slice(0, 150));
      return { text: `exit ${code}${body.length ? ` · ${body.length} line${body.length === 1 ? "" : "s"}` : ""}`, more: tail, bad: code !== "0" };
    }
    default: return { text: lines[0].slice(0, 160) };
  }
}

/**
 * Streamed markdown, one complete line at a time. Stateful only for code fences,
 * so the caller keeps one renderer per assistant message.
 */
export function mdRenderer() {
  let fence = false;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, (_, c) => cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => bold(b))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_, p, i) => p + ital(i))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${blue(t)} ${gray(`(${u})`)}`);
  return (line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return gray(line.trim()); }
    if (fence) return cyan(line);
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) return bold(inline(h[2]));
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (li) return `${li[1]}${gray("•")} ${inline(li[2])}`;
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) return `${ol[1]}${gray(ol[2] + ".")} ${inline(ol[3])}`;
    if (/^\s*>\s?/.test(line)) return gray("│ ") + ital(inline(line.replace(/^\s*>\s?/, "")));
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) return gray("─".repeat(40));
    return inline(line);
  };
}

const VERBS = ["Thinking", "Working", "Pondering", "Tinkering", "Reckoning", "Figuring", "Cooking", "Mulling", "Chewing on it"];
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
export const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];
export function spinnerFrame(i, verb, secs, extra = "") {
  return `${amber(GLYPHS[i % GLYPHS.length])} ${amber(verb + "…")} ${gray(`(${secs}s${extra ? " · " + extra : ""} · esc to interrupt)`)}`;
}

export const MODES = ["ask", "edits", "yolo"];
export function modeLabel(mode) {
  if (mode === "edits") return amber("⏵⏵ accept edits on") + gray(" (shift+tab to cycle)");
  if (mode === "yolo") return red("⏵⏵ yolo: nothing asks") + gray(" (shift+tab to cycle)");
  return gray("? /help · shift+tab: accept edits");
}

/** The line under the input box. */
export function statusLine({ mode, model, ctxPct, cwd, liveId, width = 80 }) {
  const right = gray(`${model.split(":")[0]} · ctx ${ctxPct}% · ${cwd}${liveId ? ` · phone ✓ ${liveId}` : ""}`);
  const left = modeLabel(mode);
  const room = width - vis(left) - 6;
  const r = vis(right) > room ? gray(clip(strip(right), Math.max(8, room))) : right;
  const gap = width - vis(left) - vis(r) - 4;
  return "  " + left + (gap > 1 ? " ".repeat(gap) : "  ") + r;
}
