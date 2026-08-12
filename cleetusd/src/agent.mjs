// src/agent.mjs — the loop. Ask, use tools, answer, write it down.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";
import { chat, quick } from "./ollama.mjs";
import { AGENTS, isAgent, agentMenu } from "./agents.mjs";
import { TOOLS, toolSchemas, callTool } from "./tools/index.mjs";
import { startRun, logStep, finishRun, loadMemory, relevantSkills, remember,
         rememberForAgent, loadAgentMemory, loadAllAgentMemory } from "./memory.mjs";
import { teachFromRun } from "./teacher.mjs";

// Dossiers that live in the vault as markdown. Small enough to inject whole,
// and injected EAGERLY: an agent that has to remember to go looking for
// Grayson's skin history will sometimes not bother, and generic advice is the
// exact failure this whole registry exists to prevent.
const DOSSIERS = {
  health: ["CRITICAL_FACTS.md", "40-Areas/Health/health.md", "40-Areas/Health/body.md"],
  routine: ["40-Areas/Health/routine.md"],
  wardrobe: ["40-Areas/Health/wardrobe.md"],
  codebase: ["30-Projects/Cleetus/architecture.md"],
};

// Live numbers are NOT injected — they go stale and they cost a round trip on
// every message. The agent is told where they are and fetches when it needs to.
const LIVE_HINTS = {
  training: "Your real lifting history is at /api/fitness/history and today's session at /api/fitness/workout via cloud_api. Never guess a number he can look up.",
  nutrition: "His targets are at /api/nutrition/targets and today's food at /api/nutrition/diary via cloud_api.",
  finance: "His live accounts are at /api/plaid/accounts, investments at /api/schwab/balances, business P&L at /api/ledger/pnl via cloud_api.",
  weather: "Today's weather where he actually is comes back with /api/outfit via cloud_api.",
};

// Per-file ceiling on an injected dossier. 12k characters is roughly 3k tokens
// against a 262k window, so this is a guard against one runaway file, not a
// budget. The previous 4k silently cut the architecture dossier mid-sentence
// and took the traps section with it — the part the builder agent most needed.
const DOSSIER_MAX = Number(process.env.CLEETUSD_DOSSIER_MAX || 12_000);

// A template is not a dossier. These files ship with every field blank and a
// `status: unfilled` marker in the frontmatter, and a non-empty file was
// counting as filled — so the agent received a wall of empty prompts and the
// instruction to go and ask never fired. Read the marker instead of the length.
function isUnfilled(text) {
  return /^status:\s*unfilled\s*$/m.test(text.slice(0, 400));
}

async function loadDossier(need) {
  const files = DOSSIERS[need] || [];
  const parts = [];
  let anyFilled = false;
  for (const f of files) {
    const text = await readFile(join(CONFIG.vault, f), "utf8").catch(() => "");
    if (!text.trim()) continue;
    if (isUnfilled(text)) {
      // Hand over the headings but not the blanks: the agent needs to know
      // what belongs in this file so it can ask for the right thing, and
      // nothing is gained by reading forty empty colons.
      const headings = text.split("\n").filter((l) => /^#{2,3} /.test(l)).join("\n");
      parts.push(`### ${f}\nNOT FILLED IN. It covers:\n${headings}\n\nNone of it is known. Do not infer any of it.`);
      continue;
    }
    anyFilled = true;
    // Truncation announces itself. A dossier quietly cut in half reads to the
    // model as a complete document that simply does not mention the thing it
    // was cut before.
    parts.push(
      text.length > DOSSIER_MAX
        ? `### ${f}\n${text.slice(0, DOSSIER_MAX)}\n\n[TRUNCATED — ${f} is ${text.length} chars, showing the first ${DOSSIER_MAX}. Read the rest with vault_read before relying on this.]`
        : `### ${f}\n${text}`,
    );
  }
  return { text: parts.join("\n\n"), anyFilled };
}

/**
 * What to do about a dossier nobody has written yet.
 *
 * The first version of this ended "never ask for something the answer does not
 * actually depend on", and the model took it: asked what to change about
 * breakouts, it decided the dossier was not needed and produced advice that
 * would fit any stranger. A get-out clause in a prompt WILL be used. So the
 * test is now the opposite one — would this answer suit someone else? — which
 * has an observable answer rather than asking the model to predict its own
 * information needs.
 */
function askToFill(need) {
  const target = join(CONFIG.vault, (DOSSIERS[need] || [])[0] || "");
  return (
    `### ${need} — it is empty, and that is the problem\n` +
    `Before you answer, read back what you are about to say and ask: would this ` +
    `be just as true for a stranger? If yes, you are guessing, and generic advice ` +
    `is the exact failure this file exists to prevent. Do not pad it with ` +
    `caveats — ask him the ONE thing that would make the answer his, wait for it, ` +
    `then write what he says into ${target} with write_file under the heading it ` +
    `belongs to, keeping the headings already there.\n` +
    `Ask about ONE thing. Count your question marks before sending and pick the ` +
    `single answer that unlocks the most; the rest can wait, he will come back.\n` +
    `Answer whatever part you genuinely can from what you already know first, ` +
    `then ask. Be plain that the rest is waiting on him.`
  );
}

/* Measured on laguna, same prompt, repeated runs:
 *   original wording  -> no question at all, generic advice fit for a stranger
 *   + "would this suit a stranger?" test -> asks, but five questions at once
 *   + "exactly one question mark"        -> settles at two, consistently
 * Two closely-related questions is the real behaviour and it is fine — the
 * failure being prevented was a questionnaire, and that is gone. Left at the
 * plainer wording because the mechanical phrasing bought nothing over it, and
 * an instruction claiming a limit it does not achieve teaches the next reader
 * something false about the model.
 */

/**
 * The agent's standing brief.
 *
 * Prefers brain/agents/<id>.md — the same file the deployed app reads — so a
 * brief edited once applies to both halves. The inline one-liner in agents.mjs
 * is the fallback, and exists so a new agent works before anyone writes its
 * file, not as a second place to maintain the real thing.
 */
async function loadBrief(agentId, fallback) {
  const text = await readFile(join(CONFIG.agentBriefs, `${agentId}.md`), "utf8").catch(() => "");
  return text.trim() ? text.trim() : fallback;
}

async function buildSystem(agentId, question) {
  const agent = AGENTS[agentId] || AGENTS.cleetus;

  const isGeneralist = agentId === "cleetus";
  const [memory, skills, own, others] = await Promise.all([
    loadMemory(),
    relevantSkills(question),
    // A specialist reads its own file in full and nobody else's — that is what
    // makes it specialised.
    isGeneralist ? "" : loadAgentMemory(agentId),
    // The generalist reads a headline of every specialist, so it is never the
    // least informed thing in the system.
    isGeneralist ? loadAllAgentMemory() : "",
  ]);

  const dossiers = [];
  const hints = [];
  for (const need of agent.needs || []) {
    if (DOSSIERS[need]) {
      const { text: d, anyFilled } = await loadDossier(need);
      if (d) {
        dossiers.push(d);
        // Files present but every one of them still a template counts as
        // unfilled: the agent should ask rather than answer from nothing.
        if (!anyFilled) dossiers.push(askToFill(need));
      }
      // Nothing there at all — same remedy as a file full of blanks.
      else dossiers.push(`### ${need}\nNo file yet. Do NOT invent any of it.\n\n${askToFill(need)}`);
    }
    if (LIVE_HINTS[need]) hints.push(LIVE_HINTS[need]);
  }

  const brief = await loadBrief(agentId, agent.brief);

  return [
    `You are Cleetus, Grayson's private assistant. You are the ${agent.label} agent.`,
    brief,
    "",
    // The identity problem, stated once and truthfully. Left to infer it, the
    // model answers from its tool list and claims to be whatever it reads there.
    `You run on ${CONFIG.model} through Ollama, on Grayson's own Mac Studio, as a process on that machine — not in a browser and not on anybody's cloud API. You have real access to his files, his shell, his Obsidian vault and his accounts. Nothing you read here leaves this machine unless a tool sends it.`,
    "",
    "Talk like a sharp friend who knows his stuff: direct, concrete, specific with names and numbers. No corporate hedging, no filler, no disclaimers, no 'consult a professional' unless it is genuinely a doctor's call. Never use em dashes.",
    // The exception used to read "steps he follows while doing something else",
    // which a skincare routine satisfies exactly — so the skin agent answered
    // in bold headers and numbered lists and was obeying the rule as written.
    // Narrowed to technical work, with advice named on the plain-text side.
    "Plain text. No headers, no bold, no numbered lists, no bullet symbols. Advice, recommendations, answers about his body, money, day or plans are all plain text — write them as you would say them out loud, in sentences and short paragraphs. If you find yourself numbering things, they are almost certainly sentences.",
    "Two exceptions only: a document that is meant to be formatted, like a contract, and technical work where structure is the content — code, a file walkthrough, a command sequence, a side-by-side comparison. Nothing else. Unsure? Plain text.",
    "",
    "Use your tools rather than guessing. If he mentions a project, a file or a person, go and look before you answer. If you learn something durable about him, call remember_fact. If you work out how to do something repeatable, call save_skill.",
    hints.length ? "\n" + hints.join("\n") : "",
    memory ? `\n## What you know about Grayson\n(Shared. Everything here was told to Cleetus or to one of the agents, and every agent sees it.)\n${memory}` : "",
    own ? `\n## What YOU have learned as the ${agentId} agent\n(Yours specifically. He told you these; no other agent sees them.)\n${own}` : "",
    others ? `\n## What he has told the specialists\n(Headlines only — you are the generalist, so you know THAT they know. Read ${join(CONFIG.memoryRoot, "agents")}/<agent>.md with read_file for the detail.)\n${others}` : "",
    dossiers.length ? `\n## Dossier\n${dossiers.join("\n\n")}` : "",
    skills.length ? `\n## Procedures you have learned\n${skills.map((s) => `**${s.title}** (use when ${s.when})\n${s.body}`).join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Which specialist should take this. Runs on the 8B gate so picking a router
 * does not queue behind the 33B that will do the actual work.
 */
export async function route(question) {
  try {
    const answer = await quick(
      `Message: "${String(question).slice(0, 500)}"\n\nWhich agent handles this? Reply with the id only.`,
      {
        system: `You route messages to one agent. Reply with a single id and nothing else.\n${agentMenu()}\n- cleetus: anything else, or general conversation.`,
        maxWords: 3,
      },
    );
    const id = answer.toLowerCase().replace(/[^a-z]/g, "");
    return isAgent(id) ? id : "cleetus";
  } catch {
    return "cleetus";
  }
}

/**
 * One full exchange. `history` is the conversation so far; the last entry is
 * the new user message.
 */
/**
 * Was that answer a failure? Narrow on purpose — every true here costs a call
 * to the cloud teacher, and running Cleetus locally is the whole point.
 *
 * "I can't do that" only counts when he CAN. This exists to catch him refusing
 * to touch the machine he is running on — claiming he cannot read a file while
 * holding read_file — not to catch him being honest about a real boundary.
 *
 * It used to fire on any disclaimer at all, so "I don't have the ability to
 * place purchases on Amazon" — true, correct, exactly what he should say — was
 * filed as a failure and sent to Claude to be fixed. It cannot be fixed. It is
 * not broken. So the disclaimer now has to be ABOUT something in reach.
 */
export function looksFailed({ answer = "", used = [] }) {
  if (used.length > 0 && !answer) return true;      // ran tools, said nothing
  if (!answer.trim()) return true;                  // said nothing at all
  if (used.length > 0) return false;                // it did some work

  const disclaims = /\bI (cannot|can't|can not|don't have|do not have|am unable)\b/i.test(answer);
  if (!disclaims) return false;
  return /\b(file|files|folder|directory|directories|disk|drive|computer|machine|laptop|mac|shell|terminal|command|script|vault|obsidian|note|notes|memory|remember|desk light|camera|codebase|repo)\b/i
    .test(answer);
}

export async function ask({ history, agent, onStep }) {
  const last = [...history].reverse().find((m) => m.role === "user");
  const question = last?.content || "";
  const agentId = isAgent(agent) ? agent : await route(question);

  const run = await startRun({ agent: agentId, request: question });
  const system = await buildSystem(agentId, question);
  const messages = [{ role: "system", content: system }, ...history];
  const used = [];
  let answer = "";

  for (let step = 0; step < CONFIG.maxSteps; step++) {
    const res = await chat({ messages, tools: toolSchemas() });
    answer = res.text || answer;

    if (!res.toolCalls.length) break;

    // Record the assistant turn verbatim so tool ids line up on the next pass.
    messages.push(res.raw);

    for (const call of res.toolCalls) {
      const name = call.function?.name;
      const args = call.function?.arguments || {};
      onStep?.({ tool: name, args });
      const result = await callTool(name, args, { agentId });
      used.push(name);
      await logStep(run, { tool: name, args, result });
      messages.push({ role: "tool", tool_name: name, content: String(result).slice(0, 60_000) });
    }
  }

  // Ran out of steps still holding the tools, and never wrote a sentence. All
  // that work — twelve searches through the vault — was about to be thrown away
  // and returned as an empty string, which reads as Cleetus ignoring you.
  //
  // One more pass with NO tools offered. He cannot call anything, so the only
  // move left is to answer from what he already found.
  if (!answer.trim() && used.length) {
    messages.push({
      role: "user",
      content:
        "You are out of tool calls. Answer now from what you already found above. " +
        "If it was not enough, say what you looked at and what is still missing.",
    });
    const res = await chat({ messages }).catch(() => null);
    answer = res?.text || answer;
  }

  // Anything he stated about himself, kept without him having to ask. The model
  // also has remember_fact; this is the backstop for when it does not think to
  // use it, because a fact volunteered once and lost is the thing that makes an
  // assistant feel like it is not listening.
  const stated = question.match(/\b(?:i am|i'm|my|i have|i've|i want|i need|i decided|remember that)\b/i);
  if (stated && question.length < 400 && !used.includes("remember_fact")) {
    // Told to a specialist, remembered by that specialist; told to the front
    // door, remembered by everyone. Where a fact lands should follow who he
    // was talking to.
    await rememberForAgent(agentId, question.trim()).catch(() => {});
  }

  // Did this actually work? See looksFailed — deliberately narrow, because a
  // teacher call on every answer would mean every request costs a cloud call,
  // which is the arrangement this whole daemon exists to end.
  const failed = looksFailed({ answer, used });

  await finishRun(run, { answer, status: failed ? "failed" : "done" });

  if (failed) {
    // Fire and forget. A teacher outage must not turn a bad answer into no
    // answer, so this is never awaited into the response path.
    teachFromRun({
      task: question,
      answer: answer || "(it produced nothing)",
      used,
      agent: agentId,
    }).catch(() => {});
  }

  return { answer, agent: agentId, used, run: run.path, failed };
}
