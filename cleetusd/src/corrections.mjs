// src/corrections.mjs — the only signal that compounds.
//
// Every fix to the image agent so far was made by hand, by somebody reading a
// run file. Nothing in the system found any of them, and the reason is one
// line in looksFailed:
//
//     if (used.length > 0) return false;        // it did some work
//
// A run that called a tool is a success. So a request that generated entirely
// the wrong picture is recorded as a win, every time, and the teacher — the
// thing that turns failures into learned procedure — can never fire for it.
// The agent whose failures are most frequent and most subjective is the only
// one that never learns from them.
//
// But he tells us. Every time he types "that's not what I asked for" or "I
// didn't ask for a hat", that is a labelled failure, free, in his own words,
// about the turn immediately before. literal.mjs already detects it and uses
// it to stop treating the correction as a fresh brief — and then throws it
// away. This keeps it.
//
// WHAT IS STORED IS A RULE, NOT A TRANSCRIPT, and that distinction is the
// whole design rather than a detail. Before last night the image agent's
// memory held five lines and all five were his own past requests, read back
// into every image prompt forever. Asked for "the same shot but warmer light"
// about a photograph of a bassist, it produced a woman on a tropical beach,
// because the beach was in its memory and the bassist was only in the
// conversation. A memory that fills with what he ASKED FOR makes the assistant
// worse the more it is used.
//
// So a correction is distilled into an imperative the agent can follow next
// time, and anything that fails to distil is DROPPED. Saying nothing is a fine
// outcome here; storing a sentence that will steer every future picture is not.

import { chat } from "./ollama.mjs";
import { CONFIG } from "./config.mjs";
import { isCorrection } from "./literal.mjs";
import { rememberForAgent, loadAgentMemory } from "./memory.mjs";

/* How many rules an agent keeps. The file is read IN FULL on every message to
   that agent, so this is a live context cost on every request, not archive
   size. Twenty short imperatives is a page; two hundred is a second system
   prompt nobody wrote on purpose. */
export const MAX_RULES = 20;

/* An imperative, not a sentence about him. These are the openings a usable
   rule actually has — a verb, or a condition followed by one. */
const IMPERATIVE = /^(?:never|always|do not|don't|when |if |avoid |keep |use |ask |start |stay |leave |prefer |treat |render |generate |assume |default |check |confirm )/i;

/* Things a picture, or a request for one, actually contains. A rule naming
   none of these is abstract advice. */
const CONCRETE = new RegExp("\\b(?:" + [
  // what is in the frame
  "clothing|garment|headwear|hat|prop|object|person|people|face|hands?|background|foreground",
  "text|lettering|logo|watermark|sign",
  // how it is made
  "aspect|square|portrait|landscape|tall|wide|crop|shape|ratio|size|resolution",
  "colour|color|light|lighting|shadow|angle|lens|composition|style|grain|palette",
  // the controls this agent actually has
  "prompt|negative|seed|reference|model|strength|steps|guidance|turbo|realvis|sdxl|flux",
  // the shapes of the work
  "cover|thumbnail|poster|flyer|story|reel|album|banner|hero|photo|photograph|image|picture|video|clip",
  // what he names
  "word|wording|subject|garments?|accessor(?:y|ies)",
].join("|") + ")\\b", "i");

/* The shapes that mean distillation failed and produced a transcript instead.
   First person is the tell: a rule is about what the AGENT does, so any
   sentence about what HE wants is a copy of the input wearing a hat. */
/* ── The worked example is load-bearing, and it is also a thing to be copied ──
   Both halves were measured, and they pull against each other.

   WITHOUT the example, the 33B answers every correction with a platitude:
   "Always verify all details match the user's exact request", "Always verify
   specific format requirements", "Always verify user requests match your
   response". Four cases, four variations on the word verify, none naming
   anything a picture contains. The concreteness gate rejects all of them, so
   the loop learns nothing at all.

   WITH the example, it names categories properly — and sometimes reproduces
   the example itself. The 8B did it constantly: shown the hat example it
   produced the hat rule for a correction about IGNORING A REFERENCE PICTURE,
   and again for a tweak with no lesson in it. That is the most convincing kind
   of wrong, because it reads perfectly and has nothing to do with what he
   said.

   So the example stays and echoes are refused, which leaves one real
   false-negative: if he is genuinely corrected about the example's own
   scenario, the correct rule is rejected as an echo.

   That is why the example is a lesson the agent ALREADY HAS. "Add nothing he
   did not name" is in the image brief and in literal.mjs's clause. The one
   thing this guard can wrongly refuse to learn is the one thing that was
   already known — which makes the cost of the trade approximately nothing. */
const EXAMPLE_RULES = [
  "never add clothing, headwear or props he did not name",
];

const NOT_A_RULE = [
  /\bi (?:want|need|asked|said|told|would like|didn'?t|never)\b/i,
  /\byou (?:added|changed|ignored|forgot|missed)\b/i,   // his complaint, echoed
  /\?\s*$/,                                             // a question
  /^(?:sure|okay|ok|got it|understood|noted|apolog)/i,  // acknowledgement
  /\b(?:as an ai|i'?m sorry|i apologise|i apologize)\b/i,
];

/**
 * Is this string a rule worth keeping, or the correction wearing a disguise?
 *
 * Pure and exported so the judgement can be tested without a model, which
 * matters: this is the gate that decides what gets injected into every future
 * request, and a gate that can only be exercised through a 33B is a gate
 * nobody exercises.
 */
export function usableRule(rule, { asked = "", correction = "" } = {}) {
  const r = String(rule || "").trim().replace(/\s+/g, " ").replace(/^["'`]|["'`]$/g, "");
  if (!r) return { ok: false, why: "empty" };
  if (r.length < 12) return { ok: false, why: "too short to be a rule" };
  if (r.length > 220) return { ok: false, why: "too long — a rule has to be readable at a glance" };
  if (!IMPERATIVE.test(r)) return { ok: false, why: "not an instruction the agent can follow" };
  for (const bad of NOT_A_RULE) {
    if (bad.test(r)) return { ok: false, why: "reads as a transcript of what he said, not a rule" };
  }
  /* ── Vague is worse than nothing ─────────────────────────────────────────
     Measured on the first run of this. Given "again, but warmer" — a tweak
     with no lesson in it — the model was asked to output NONE and instead
     produced "Never assume additional details beyond what is explicitly
     requested."

     That sentence is unobjectionable, useless, and permanent. It names
     nothing, so it changes no decision, and it is read into every future
     image request forever. Twenty of those IS the second system prompt this
     file's header warns about, and they arrive one reasonable-looking line at
     a time.

     A rule that helps has to name something a picture actually has. This is a
     whitelist rather than a cleverness test, and it will need extending as the
     agent grows — which is the right direction to be wrong in, because the
     failure mode of a whitelist is "nothing learned this time" and the failure
     mode of a guess is a memory full of platitudes. */
  if (!CONCRETE.test(r)) {
    return { ok: false, why: "names nothing concrete — a rule that changes no decision is noise" };
  }
  for (const ex of EXAMPLE_RULES) {
    if (overlap(r, ex) > 0.75) {
      return { ok: false, why: "echoes the worked example in the prompt rather than this conversation" };
    }
  }
  // A near-copy of either input is the failure this whole file exists to
  // prevent, and it will not always announce itself with "I want".
  for (const [label, source] of [["his request", asked], ["his correction", correction]]) {
    if (source && overlap(r, source) > 0.7) {
      return { ok: false, why: `too close to ${label} — it is a copy, not a lesson` };
    }
  }
  return { ok: true, rule: r.endsWith(".") ? r : `${r}.` };
}

/** Fraction of the rule's words that came straight from the source. */
function overlap(rule, source) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z']{3,}/g) || []);
  const a = words(rule);
  const b = words(source);
  if (!a.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / a.size;
}

/**
 * The turn he is correcting: what he asked, and what he was given.
 *
 * Read from the conversation rather than the run files, because the
 * conversation is what HE is reacting to — the answer on his screen — and a
 * run file records what the machine believes it did. When those disagree, the
 * one he corrected is the one on the screen.
 */
export function previousAttempt(history = []) {
  const text = (m) => (Array.isArray(m?.content)
    ? m.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
    : String(m?.content || "")).trim();

  // Walk back past the correction itself to the exchange before it.
  const turns = [...history];
  while (turns.length && turns[turns.length - 1]?.role !== "assistant") turns.pop();
  const answer = turns.pop();
  if (!answer) return null;
  while (turns.length && turns[turns.length - 1]?.role !== "user") turns.pop();
  const request = turns.pop();
  if (!request) return null;

  const asked = text(request);
  const made = text(answer);
  if (!asked || !made) return null;
  return { asked, made };
}

const DISTIL_SYSTEM =
  "Grayson corrected the assistant. Write the ONE rule the assistant should follow from now on so " +
  "the same mistake does not happen again.\n\n" +
  "Output exactly one imperative sentence, under 25 words, addressed to the assistant. It must " +
  "start with a verb or with When/If/Never/Always. Output the sentence and nothing else — no " +
  "preamble, no quotes, no explanation.\n\n" +
  "GENERALISE. The rule must be about how to work, not about this one picture. If he says he did " +
  "not ask for a hat, the rule is about not adding clothing or props he never named — not about " +
  "hats. A rule that only helps if he asks for the exact same thing again is worthless.\n\n" +
  "Never write a sentence about what HE wants or what he said. The rule is about what YOU do.\n" +
  "Many corrections carry NO lesson. \"again, but warmer\" is an ordinary tweak, not a mistake to " +
  "learn from; so is a change of mind. In those cases output the single word NONE. A vague rule such " +
  "as \"always verify requests\" or \"avoid assumptions\" is WORSE than NONE, because it names " +
  "nothing, changes no decision, and is read back on every future request forever.\n" +
  "If there is no general lesson here, output the single word: NONE\n\n" +
  /* Two worked examples, because instructions alone did not hold. Measured on
     the 8B: told to generalise, it produced "Never add elements not requested"
     — abstract enough to change no decision. Told to generalise AND shown what
     that looks like, it names the category. Small models copy shape. */
  "EXAMPLE\n" +
  "He asked for: a bassist on a dim club stage\n" +
  "Produced: a bassist in a wide-brimmed hat on a dim stage\n" +
  "He said: i didnt ask for a hat\n" +
  "Rule: Never add clothing, headwear or props he did not name.\n\n" +
  "EXAMPLE\n" +
  "He asked for: a picture of a dog\n" +
  "Produced: a golden retriever in a field\n" +
  "He said: again, but warmer\n" +
  "Rule: NONE\n\n" +
  "Name the CATEGORY, the way the first example names clothing rather than hats. " +
  "A rule that mentions nothing a picture actually contains — no clothing, colour, shape, aspect, " +
  "prompt, reference, seed, text, background — is the vague kind, and NONE is better than it.";

/**
 * Turn one correction into one rule. Returns null when there is no lesson —
 * which is a normal outcome and much better than a bad rule.
 */
export async function distilRule({ asked, made, correction }) {
  const user =
    `He asked for:\n${clip(asked, 600)}\n\n` +
    `The assistant produced:\n${clip(made, 600)}\n\n` +
    `He then said:\n${clip(correction, 400)}`;
  let text = "";
  try {
    /* THE MAIN MODEL, not the 8B gate model, and the first version had this
       wrong. Measured on the 8B: given a correction about ignoring a reference
       picture it produced the hat rule from the worked example, and given a
       tweak with no lesson it produced the hat rule again. It was pattern
       matching on the prompt rather than reading the conversation.

       This costs a 33B call, which is fine because the caller does not wait
       for it — see captureCorrection's call site. The same reasoning as
       teachFromRun: bookkeeping must never turn a slow answer into no answer. */
    const res = await chat({
      messages: [{ role: "system", content: DISTIL_SYSTEM }, { role: "user", content: user }],
      model: CONFIG.model,
      temperature: 0.2,
    });
    text = (res.text || "").trim();
  } catch {
    return null;                       // never fail a turn over bookkeeping
  }
  if (!text || /^none\b/i.test(text)) return null;
  // One sentence, whatever it sent.
  const first = text.split(/\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
  const verdict = usableRule(first, { asked, correction });
  return verdict.ok ? verdict.rule : null;
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * The whole loop, called from ask() once the answer is written.
 *
 * Returns a short note for the log, or null when nothing was learned. Never
 * throws: a failure to learn must not become a failure to answer.
 */
export async function captureCorrection({ agentId, question, history, probe = false }) {
  // `probe` is a benchmark. Writing a rule from one would mean the tests teach
  // the assistant, which is how the memory filled with junk in the first place.
  if (probe) return null;
  if (!agentId || agentId === "cleetus") return null;
  if (!isCorrection(question)) return null;
  if (process.env.CLEETUSD_NO_LEARNING === "1") return null;

  const prev = previousAttempt(history);
  if (!prev) return null;

  const rule = await distilRule({ asked: prev.asked, made: prev.made, correction: question });
  if (!rule) return null;

  // Already known, in substance rather than in wording.
  const existing = await loadAgentMemory(agentId).catch(() => "");
  for (const line of String(existing).split("\n")) {
    const known = line.replace(/^- /, "").replace(/\s*_\(\d{4}-\d\d-\d\d\)_\s*$/, "");
    if (known && overlap(rule, known) > 0.8) return null;
  }

  await rememberForAgent(agentId, rule).catch(() => {});
  await pruneRules(agentId).catch(() => {});
  return rule;
}

/**
 * Keep the newest MAX_RULES. Oldest first out, because a rule that has not
 * been re-learned in twenty corrections is one the agent either absorbed or
 * never needed, and the file is read in full on every single message.
 */
export async function pruneRules(agentId) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const path = join(CONFIG.memoryRoot, "agents", `${agentId}.md`);
  let text = "";
  try { text = await readFile(path, "utf8"); } catch { return 0; }
  const lines = text.split("\n");
  const rules = lines.filter((l) => l.startsWith("- "));
  if (rules.length <= MAX_RULES) return 0;
  const drop = new Set(rules.slice(0, rules.length - MAX_RULES));
  await writeFile(path, lines.filter((l) => !drop.has(l)).join("\n"), "utf8");
  return drop.size;
}
