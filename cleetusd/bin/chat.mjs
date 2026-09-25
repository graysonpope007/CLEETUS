#!/usr/bin/env node
// bin/chat.mjs — talk to Cleetus HIMSELF from the terminal.
//
//   node bin/chat.mjs                interactive
//   node bin/chat.mjs --agent finance "how's cash looking"
//   cleetus chat                     (the wrapper points here)
//
// This is NOT bin/cleetus.mjs. That one is a coding agent with a small file/shell
// tool set and a coding brief. THIS is the real Cleetus: ask() routes to the
// right agent, injects the vault dossiers, holds the whole 24-agent tool set,
// and writes each turn into the run log — the same brain the phone and the web
// app talk to. The only difference here is the transport is your terminal.
//
// History is kept in-process so it is a conversation, not a series of cold
// questions. `used` (the tools he reached for) is printed dimmed so you can see
// him work, exactly like the phone shows.

import { ask } from "../src/agent.mjs";
import * as readline from "node:readline";

const argv = process.argv.slice(2);
const ai = argv.indexOf("--agent");
let forcedAgent = null;
if (ai !== -1) { forcedAgent = argv[ai + 1]; argv.splice(ai, 2); }
const oneShot = argv.join(" ").trim();

const tty = process.stdout.isTTY;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c(2), bold = c(1), cyan = c(36), green = c(32), red = c(31), yellow = c(33);

const history = [];

async function turn(text) {
  history.push({ role: "user", content: text });
  const spin = tty ? spinner() : null;
  let out;
  try {
    out = await ask({
      history,
      agent: forcedAgent,
      probe: false, // Grayson talking, not a test: his runs show in Recent work
      onStep: ({ tool }) => { spin?.note(tool); },
    });
  } catch (e) {
    spin?.stop();
    console.log(red(`  error: ${e.message}`));
    history.pop();
    return;
  }
  spin?.stop();
  const answer = out?.answer ?? "(no answer)";
  history.push({ role: "assistant", content: answer });
  process.stdout.write(answer.endsWith("\n") ? answer : answer + "\n");
  const used = Array.isArray(out?.used) ? out.used : [];
  const bits = [out?.agent && out.agent !== "cleetus" ? `agent ${out.agent}` : null,
                used.length ? `used ${used.join(", ")}` : null,
                out?.failed ? yellow("flagged as a possible non-answer") : null].filter(Boolean);
  if (bits.length && tty) console.log(dim(`  · ${bits.join(" · ")}`));
}

function spinner() {
  const f = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0, last = "", on = true, t0 = Date.now();
  const iv = setInterval(() => {
    const s = `${cyan(f[i++ % 10])} ${dim(`Cleetus ${last ? "· " + last + " " : ""}${((Date.now() - t0) / 1000).toFixed(0)}s`)}`;
    process.stdout.write("\r\x1b[K" + s);
  }, 100);
  return { note(tool) { last = tool; }, stop() { if (on) { on = false; clearInterval(iv); process.stdout.write("\r\x1b[K"); } } };
}

if (oneShot) { await turn(oneShot); process.exit(0); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, historySize: 500 });
console.log(`${bold(cyan("Cleetus"))} ${dim("· local · your terminal · /agent <name> to pin an agent · /exit")}`);
let lastSigint = 0;
rl.on("SIGINT", () => {
  if (Date.now() - lastSigint < 1500) { console.log(); process.exit(0); }
  lastSigint = Date.now(); console.log(dim("\n  (ctrl-c again to exit)")); rl.prompt();
});

while (true) {
  const line = await new Promise((res) => rl.question(bold(green("you › ")), res)).catch(() => null);
  if (line === null) break;
  const q = line.trim();
  if (!q) continue;
  if (q === "/exit" || q === "/quit") break;
  if (q === "/clear") { history.length = 0; console.log(dim("  new conversation")); continue; }
  if (q.startsWith("/agent")) { forcedAgent = q.split(/\s+/)[1] || null; console.log(dim(`  agent: ${forcedAgent || "auto-route"}`)); continue; }
  if (q === "/help") { console.log(dim("  /agent <name> pin an agent · /agent alone to auto-route · /clear · /exit")); continue; }
  await turn(q);
}
rl.close();
process.exit(0);
