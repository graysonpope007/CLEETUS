// src/agent.mjs — the loop. Ask, use tools, answer, write it down.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.mjs";
import { chat, quick, see, visionReady } from "./ollama.mjs";
import { AGENTS, isAgent, agentMenu, agentList } from "./agents.mjs";
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
    // Asked about a product name it had never seen, the nutrition agent invented
    // a confident history for it — origin, era, what it superseded — with no
    // hedge and no tool calls. The style rule above is part of why: "no
    // hedging, no disclaimers" reads as a instruction never to say "I don't
    // know", and the model resolved the conflict by producing something that
    // sounded right. So the two are reconciled here rather than left to fight.
    "If you do not know something, say so in one short sentence and stop. A product, a person, a term, a number you have not seen — say you have not seen it, then look it up if a tool can. Never fill the gap with something that merely sounds right; a confident invention is the single worst thing you can hand him, because he will act on it. 'No hedging' means do not pad an answer you actually have. It is not permission to manufacture one you do not.",
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
        // "cleetus: anything else" was listed like a normal option and the gate
        // took it constantly — a question about breakouts routed to the
        // generalist, so the skin brief and skin memory never loaded and the
        // entire specialist design was bypassed. Measured 4/12 before this.
        // It is now described as the last resort it is.
        system:
          `You route a message to the ONE agent whose speciality fits best.\n` +
          `${agentMenu()}\n- cleetus: ONLY if no agent above fits at all.\n\n` +
          `Always prefer a specific agent over cleetus. A question about his body, ` +
          `money, clothes, food or work belongs to a specialist, not the generalist. ` +
          `Reply with the id alone.`,
        maxWords: 3,
      },
    );

    // Find a known id INSIDE the reply rather than demanding the reply be one.
    //
    // The gate answered "\boxed{nutrition}" — the correct id, wrapped in LaTeX
    // by a model that had been asked for one word. Stripping non-letters turned
    // that into "boxednutrition", which is not an agent, so it fell back to the
    // generalist and threw a right answer away. Small models decorate; the
    // parser should read through the decoration.
    const lower = String(answer).toLowerCase();
    const hit = agentList()
      .map((a) => a.id)
      .filter((id) => new RegExp(`\\b${id}\\b`).test(lower))
      // Longest first so "muscle" is not shadowed by a shorter id inside it.
      .sort((a, b) => b.length - a.length)[0];
    return hit && isAgent(hit) ? hit : "cleetus";
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
/**
 * Does this text stop on an announcement instead of a conclusion?
 *
 * Shared, because it is needed in two places that must agree: deciding a run
 * failed, and deciding the forced final pass has to be asked again. If those
 * two ever disagreed, a truncated answer would be handed back and simultaneously
 * recorded as fine.
 */
/**
 * Get a real answer out of a run that used up its tool calls.
 *
 * Appending "now answer" to the transcript does not work, and the reason is
 * worth stating: after twenty tool calls the context IS a tool loop, so the
 * most probable next turn is another line of narration. Measured — the first
 * version of this pushed one more user message onto those same messages and got
 * back "Let me check what might be broken by looking at the actual issue:",
 * which is the exact failure it was written to prevent.
 *
 * So the transcript is not continued. A fresh two-message conversation is built
 * from the findings: nothing in it looks like a tool loop, so nothing pulls the
 * model back into narrating one. Temperature is dropped because this is a
 * formatting instruction to follow, not a question to be creative about, and if
 * the reply still ends on a promise it is asked again, more bluntly.
 */
async function forceAnswer({ question, messages, used }) {
  const PER_TOOL = 1500;
  const TOTAL = 24_000;
  const findings = [];
  let budget = TOTAL;
  // Newest first: when the budget runs out it should be the earliest, most
  // exploratory calls that get dropped, not the ones that found the answer.
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const body = String(m.content || "").slice(0, PER_TOOL);
    const entry = `### ${m.tool_name}\n${body}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    findings.unshift(entry);
  }

  const base = [
    {
      role: "system",
      content:
        "You are writing the final answer to a question. The research is already " +
        "done and is given to you below. You have NO tools and cannot look " +
        "anything up, so there is nothing left to announce — only the answer " +
        "itself. Lead with the conclusion. Be specific: name the files, paths and " +
        "commands you found. If the research did not settle it, say what it did " +
        "establish and what is still unknown. Never end by saying you will check " +
        "something.",
    },
    {
      role: "user",
      content:
        `Question: ${question}\n\n` +
        `What ${used.length} tool calls turned up:\n\n${findings.join("\n\n")}\n\n` +
        `Write the answer.`,
    },
  ];

  let out = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0
      ? base
      : [...base, {
          role: "user",
          content:
            "That ended on something you were going to check, and you cannot check " +
            "anything. Rewrite it as a finished answer: conclusion first, then the " +
            "evidence, then what is still unknown. No sentence may begin with " +
            "\"Let me\" or \"I'll\".",
        }];
    const res = await chat({ messages: msgs, temperature: 0.3 }).catch(() => null);
    const text = res?.text?.trim();
    if (!text) continue;
    out = text;
    if (!endsOnAPromise(text)) break;
  }
  return out;
}

export function endsOnAPromise(text = "") {
  const tail = String(text).trim().slice(-220);
  if (!tail) return false;
  return /(?:^|[\s>])(?:let me|i(?:'ll| will)|now i(?:'ll| will)|next,? i(?:'ll| will))\b[^.!?]*:?\s*$/i.test(tail)
      || /\b(?:checking|looking|searching|let me see)\b[^.!?]*:\s*$/i.test(tail);
}

export function looksFailed({ answer = "", used = [] }) {
  if (used.length > 0 && !answer) return true;      // ran tools, said nothing
  if (!answer.trim()) return true;                  // said nothing at all

  // An answer that stops on a promise is not an answer. "Let me check the
  // Cleetus V2 project:" was being recorded as a successful run, so the one
  // failure mode a user actually complains about — half an answer — was the
  // only one the teacher never saw. Checked before the did-some-work exit
  // below, which used to pass every one of these straight through.
  if (endsOnAPromise(answer)) return true;

  if (used.length > 0) return false;                // it did some work

  // The refusal and the capability must be in the SAME CLAUSE.
  //
  // Browsing joined the word list the day browsing started working: the tax
  // agent said it "cannot access the Georgia DOR website" while holding
  // web_open, and refusing a capability it has is the same fault as refusing to
  // read a file. But testing whether a refusal phrase and a capability word
  // appear ANYWHERE in the answer is a different question, and widening the
  // list immediately broke this perfectly good sentence:
  //
  //   "I can browse Amazon and show you options, but I don't have the ability
  //    to actually place purchases."
  //
  // He can browse; he cannot buy. Both halves are true and the sentence is
  // exactly right. As a bag of words it reads as a refusal to browse.
  //
  // The unit test missed it because the example in it happened to contain no
  // browsing word — the test agreed with the code rather than with reality,
  // which is what a test written from the same assumption as its subject does.
  //
  // Splitting on "but" matters as much as splitting on full stops: "I can X but
  // I can't Y" is one sentence carrying two opposite claims, and only the second
  // is being graded.
  const DISCLAIM = /\bI (cannot|can't|can not|don't have|do not have|am unable)\b/i;
  const REACH = /\b(file|files|folder|directory|directories|disk|drive|computer|machine|laptop|mac|shell|terminal|command|script|vault|obsidian|note|notes|memory|remember|desk light|camera|codebase|repo|website|web|browser|browse|browsing|internet|online|url|page)\b/i;

  for (const clause of answer.split(/(?<=[.!?])\s+|\s+\bbut\b\s+/i)) {
    if (DISCLAIM.test(clause) && REACH.test(clause)) return true;
  }
  return false;
}

/**
 * Turn any pictures in the conversation into words, before the loop runs.
 *
 * The alternative — hand the whole turn to the vision model — costs everything
 * that makes this assistant his: laguna holds the tools, the memory, the
 * dossiers and the voice, and a VLM has none of them. So the eyes report and
 * laguna answers. What arrives is a normal text message with a described
 * picture attached to it, which every downstream step already understands.
 *
 * A failure here is SAID, not swallowed. "I cannot see the picture you sent"
 * is a useful sentence; answering the text alone as though nothing was attached
 * is how a model ends up confidently discussing an image it never received.
 */
async function describeImages(history, onStep) {
  const out = [];
  for (const m of history) {
    if (!Array.isArray(m.content)) { out.push(m); continue; }
    const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const images = m.content
      .filter((b) => b.type === "image" && b.source && b.source.data)
      .map((b) => b.source.data);
    if (!images.length) { out.push({ role: m.role, content: text }); continue; }

    let described;
    if (!(await visionReady())) {
      described = `[Grayson attached ${images.length} image(s). You cannot see them: the vision ` +
        `model ${CONFIG.visionModel} is not pulled on this machine. Say so plainly rather than ` +
        `guessing what is in them.]`;
    } else {
      if (onStep) onStep({ tool: "look", args: { note: `${images.length} attached image(s)` } });
      try {
        const seen = await see({
          images,
          prompt: text
            ? `${DESCRIBE_ATTACHED}\n\nHe said: "${text}". Describe what is relevant to that.`
            : DESCRIBE_ATTACHED,
        });
        // Framed as SEEING, not as a report from elsewhere. Told "the vision
        // model says X", the model treated that as evidence it was blind and
        // answered "I can't see attached pictures" with the description of the
        // picture sitting in its own context. The eyes are part of it, so the
        // sentence has to read that way.
        described = `[YOU LOOKED AT THE ATTACHED PICTURE AND THIS IS WHAT YOU SEE: ${seen}\n` +
          `Answer from what you can see. Do not say you cannot see attachments — you just did.]`;
      } catch (e) {
        described = `[Grayson attached an image and looking at it failed: ${e.message}. Say so ` +
          `rather than guessing.]`;
      }
    }
    out.push({ role: m.role, content: [text, described].filter(Boolean).join("\n\n") });
  }
  return out;
}

const DESCRIBE_ATTACHED =
  "Describe this picture plainly and specifically: what it is, what is in it, and any text you " +
  "can read, quoted. If it is food, name the items and estimate portions. Do not guess at " +
  "anything blurred or cut off. Four sentences at most, no preamble.";

export async function ask({ history, agent, onStep }) {
  /* Route on what HE said, not on what the eyes reported.
     Measured: "What am I doing in this picture?" with a photo attached went to
     the `image` agent — the one that art-directs GENERATED images — and it
     answered, correctly for what it is, that it could not see any image. The
     description injected below is full of the word "image", which drags the
     router there even harder. So the routing question is taken before the
     picture is described, and an attachment can never by itself select the
     agent whose whole job is making pictures rather than looking at them. */
  const asked = [...history].reverse().find((m) => m.role === "user");
  const askedText = Array.isArray(asked?.content)
    ? asked.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim()
    : (asked?.content || "");
  const carriedImage = history.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === "image"));

  let agentId = isAgent(agent) ? agent : await route(askedText);
  /* The `image` agent MAKES pictures; it does not look at them. The router is
     an 8B model reading blurbs, and every word that means "look" also means
     "image" to it — "what am I doing in this picture" and "look at my desk
     camera" both landed there, and it answered the first by saying it cannot
     see attachments. It is only right when he is asking for something to be
     generated, so it has to be asked for. */
  if (agentId === "image" && !isAgent(agent) &&
      !/\b(make|draw|generate|create|design|render|paint)\b/i.test(askedText)) {
    agentId = "cleetus";
  }

  history = await describeImages(history, onStep);
  const last = [...history].reverse().find((m) => m.role === "user");
  const question = last?.content || "";

  const run = await startRun({ agent: agentId, request: question });
  let system = await buildSystem(agentId, question);
  if (carriedImage) {
    // The system prompt never mentioned attachments, so the model filled the
    // gap with the safest-sounding thing it knows about itself: that it is a
    // text model. One line closes that.
    system += "\n\nGrayson has attached one or more pictures to this message. You CAN see them: " +
      "a vision model on this machine has already looked, and what it saw is written into his " +
      "message in brackets. Treat that as your own eyes. Answer the question from it directly, " +
      "and never tell him you are unable to view attachments.";
  }
  const messages = [{ role: "system", content: system }, ...history];
  const used = [];
  let answer = "";

  // Why these are tracked separately: this model narrates before it acts, so a
  // turn that calls tools usually ALSO carries a line of text — "Let me check
  // the Cleetus V2 project:". That is a preamble, not an answer. The loop used
  // to assign `answer = res.text || answer` on every pass, so each preamble
  // overwrote the last, and a run that used all its steps returned the final
  // preamble as its result: an answer that stops mid-thought on a colon, which
  // is exactly what it looked like from the outside.
  //
  // Only a turn that calls NO tools is an answer. Everything else is narration.
  let ranOut = true;
  const preambles = [];

  for (let step = 0; step < CONFIG.maxSteps; step++) {
    const res = await chat({ messages, tools: toolSchemas() });

    if (!res.toolCalls.length) {
      answer = res.text || answer;
      ranOut = false;
      break;
    }
    if (res.text && res.text.trim()) preambles.push(res.text.trim());

    // Record the assistant turn verbatim so tool ids line up on the next pass.
    messages.push(res.raw);

    for (const call of res.toolCalls) {
      const name = call.function?.name;
      const args = call.function?.arguments || {};
      onStep?.({ tool: name, args });
      const result = await callTool(name, args, { agentId });
      used.push(name);
      await logStep(run, { tool: name, args, result });
      // JSON for objects, not String(). A tool returning an object used to
      // arrive as the literal text "[object Object]", and the model does not
      // report an empty tool result — it fills the gap with something
      // plausible, which is indistinguishable from the tool having worked.
      const asText = typeof result === "string" ? result : JSON.stringify(result);
      messages.push({ role: "tool", tool_name: name, content: String(asText).slice(0, 60_000) });
    }
  }

  // Ran out of steps still holding the tools. All that work — a dozen searches
  // through the vault — used to be thrown away.
  //
  // This used to fire only when the answer was EMPTY, which is the case it
  // never actually caught: the model almost always leaves a preamble behind, so
  // `answer` was a non-empty half-sentence and the salvage was skipped. Running
  // out of steps is itself the trigger now, whatever text is sitting there.
  //
  // One more pass with NO tools offered. It cannot call anything, so the only
  // move left is to answer from what it already found.
  if (ranOut && used.length) {
    let finalText = await forceAnswer({ question, messages, used });
    // Both attempts still ended on a promise. Say so on the answer itself —
    // silently handing back half a reply is the whole bug, and it does not stop
    // being that bug because a retry produced it.
    if (finalText && endsOnAPromise(finalText)) {
      finalText += `\n\n[Stopped here after ${used.length} tool calls without reaching a conclusion. Ask again and it will pick up from what it found.]`;
    }
    // Falling back to a preamble is a last resort, and it is still better than
    // an empty bubble — but it is marked too.
    answer = finalText
      || (preambles.length
            ? `${preambles[preambles.length - 1]}\n\n[Ran out of tool calls after ${used.length} of them and could not finish. Ask again to continue from here.]`
            : answer);
  } else if (!answer.trim() && preambles.length) {
    answer = preambles[preambles.length - 1];
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
