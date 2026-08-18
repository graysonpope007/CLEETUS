// src/teacher.mjs — a bigger model teaching the local one.
//
// You cannot watch how another model did something; you only see its output.
// So this does not try to infer the lesson — it asks the teacher to WRITE the
// procedure a smaller model should follow next time. Distillation into
// instructions, not weights.
//
// WHY THIS IS NOT "JUST USE CLAUDE FOR THE HARD ONES"
// Falling back to a cloud model on every hard request means the hard requests
// are never local, forever, and Grayson's files go to a vendor every time. A
// skill is paid for once: the teacher is called when laguna FAILS, writes the
// procedure down, and laguna does it locally from then on. The check on
// whether that worked is already built — skills that keep losing get demoted
// out of retrieval (see memory.mjs).
//
// PRIVACY, stated plainly: this is the one place in cleetusd that sends
// anything off the machine. It sends the task and what the local model got
// wrong. Keep it away from anything holding his files: no vault contents, no
// file bodies, no account data. Set CLEETUSD_NO_TEACHER=1 to switch it off.

import Anthropic from "@anthropic-ai/sdk";
import { secrets } from "./config.mjs";
import { saveSkill } from "./memory.mjs";

const ENABLED = process.env.CLEETUSD_NO_TEACHER !== "1" && !!secrets.ANTHROPIC_API_KEY;

// Opus 5 is the teacher on purpose. The whole point is that it knows something
// laguna does not; a cheaper teacher writes a procedure worth less than the
// call that produced it.
const TEACHER_MODEL = process.env.CLEETUSD_TEACHER_MODEL || "claude-opus-5";

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });
  return _client;
}

// Structured output: the teacher must return a procedure in the exact shape
// saveSkill writes, so nothing has to parse prose back into steps.
const SKILL_SCHEMA = {
  type: "object",
  properties: {
    worth_saving: {
      type: "boolean",
      description: "False if this was a one-off with no repeatable procedure behind it. Be honest; a skill that will never apply again is worse than no skill.",
    },
    title: { type: "string", description: "Short imperative name, e.g. 'Close the books for a month'." },
    when: { type: "string", description: "The situation this applies to, written so a keyword search would find it." },
    steps: {
      type: "array",
      items: { type: "string" },
      description: "Ordered, concrete steps. Name real tools and real paths. Each step is something the model can actually DO, not advice.",
    },
    why_it_failed: { type: "string", description: "One sentence on what the smaller model got wrong. Not saved; used for the log." },
  },
  required: ["worth_saving", "title", "when", "steps", "why_it_failed"],
  additionalProperties: false,
};

/**
 * The tool list, read from the registry instead of typed out.
 *
 * The hardcoded version named `browse`, which was removed when the browser
 * tooling was rebuilt as web_open / web_read / web_act. So this prompt has been
 * telling the teacher to write procedures around a tool that does not exist —
 * and any skill it produced could instruct the small model to call it.
 *
 * It also named 10 tools out of 38. Everything added since — the keyring, the
 * mail path, the devices, recent_work, health_report, scheduled_jobs — was
 * invisible to the teacher, so no skill could ever use them. A list kept by hand
 * beside a registry does not stay equal to it; that is what the registry is for.
 *
 * Imported lazily: teacher.mjs is pulled in by agent.mjs, and tools/index.mjs
 * reaches back into memory.mjs, so a top-level import risks a cycle for a string
 * that is only needed when the teacher actually runs.
 */
async function toolNames() {
  try {
    const { TOOLS } = await import("./tools/index.mjs");
    return Object.keys(TOOLS).sort().join(", ");
  } catch {
    // Never invent a list. If the registry cannot be read, say nothing about
    // tools rather than describing a toolbox that may not exist.
    return null;
  }
}

const SYSTEM = [
  "You teach a smaller local model (laguna-xs-2.1, 33B, running on a Mac) to do things it just failed at.",
  "",
  "You are NOT solving the task. You are writing the PROCEDURE the smaller model should follow next time, which is a different job:",
  "- A procedure is repeatable steps. 'Pull the ledger, group by business, reconcile against Plaid, then summarise.'",
  "- A rule is not a procedure. 'Do not open the brief with weather' is a preference and belongs elsewhere.",
  "- An answer is not a procedure. If you find yourself writing the result, you are doing the wrong job.",
  "",
  "Write for a model with less headroom than you: concrete, ordered, no judgement calls it cannot make. Use real paths, and name only tools from the list below.",
  "",
  "If the failure was a one-off with no general procedure behind it, set worth_saving false and stop. A skill that never applies again costs a retrieval slot forever.",
].join("\n");

/**
 * Distil one failure into a skill.
 *
 * `context` deliberately excludes file contents and vault text — see the
 * privacy note at the top. Pass what was ASKED and what went wrong.
 */
export async function teach({ task, whatHappened, toolsUsed = [], agent = "cleetus" }) {
  if (!ENABLED) return { ok: false, reason: "teacher disabled or ANTHROPIC_API_KEY unset" };

  const prompt = [
    `The smaller model was asked:`,
    task,
    ``,
    `What happened:`,
    whatHappened,
    toolsUsed.length ? `\nTools it reached for: ${toolsUsed.join(", ")}` : "",
    ``,
    `Write the procedure it should follow next time.`,
  ].filter(Boolean).join("\n");

  // Resolved at call time so the list cannot drift from what the small model
  // can actually call.
  const toolList = await toolNames();

  let res;
  try {
    res = await client().beta.messages.create({
      model: TEACHER_MODEL,
      max_tokens: 16000,
      // Adaptive thinking is the default on Opus 5; naming it is documentation.
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SKILL_SCHEMA } },
      // Safety classifiers can decline; without a fallback the request just
      // stops. "default" routes by refusal category rather than pinning a
      // model that will eventually be deprecated.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM + (toolList ? `\n\nThe tools it has, exactly: ${toolList}. Name no others.` : ""),
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    return { ok: false, reason: `teacher call failed: ${e.message}` };
  }

  // Check stop_reason before reading content — on a refusal, content is empty
  // or partial, and indexing [0] throws.
  if (res.stop_reason === "refusal") {
    return { ok: false, reason: `teacher declined (${res.stop_details?.category ?? "no category"})` };
  }

  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let skill;
  try { skill = JSON.parse(text); } catch { return { ok: false, reason: "teacher returned unparseable output" }; }

  if (!skill.worth_saving) {
    return { ok: true, saved: false, reason: skill.why_it_failed || "teacher judged this a one-off" };
  }

  const path = await saveSkill({ title: skill.title, when: skill.when, steps: skill.steps, agent });
  return { ok: true, saved: true, path, title: skill.title, why: skill.why_it_failed, servedBy: res.model };
}

/**
 * Called from the agent loop when a run looks like a failure. Best effort and
 * never throws: a teacher outage must not turn a bad answer into a crash.
 */
export async function teachFromRun({ task, answer, used, agent }) {
  if (!ENABLED) return null;
  try {
    return await teach({
      task,
      whatHappened: `It answered: ${String(answer).slice(0, 1500)}`,
      toolsUsed: used,
      agent,
    });
  } catch {
    return null;
  }
}

export const teacherEnabled = ENABLED;
export const teacherModel = TEACHER_MODEL;
