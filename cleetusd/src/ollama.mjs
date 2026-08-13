// src/ollama.mjs — the model call, and nothing else.
//
// Native /api/chat, not the OpenAI-compatible /v1 shim. Two reasons:
//   1. `think: false` is honoured here. On /v1 it is dropped silently and
//      laguna spends 500-900 tokens reasoning before it writes a word, so any
//      call with a small budget returns a successful, silent, blank answer.
//   2. Native tool_calls come back as structured objects with ids, so a
//      multi-step loop does not have to parse JSON out of prose.

import { CONFIG } from "./config.mjs";

/**
 * One turn. Returns { text, toolCalls, raw }.
 * toolCalls is always an array, empty when the model chose to answer directly.
 */
export async function chat({ messages, tools = [], model = CONFIG.model, think = false, temperature = 0.7, signal }) {
  const body = {
    model,
    messages,
    stream: false,
    think,
    options: { temperature },
  };
  if (tools.length) body.tools = tools;

  const res = await fetch(`${CONFIG.ollama}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const msg = data.message || {};

  return {
    text: stripReasoning(msg.content || ""),
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    raw: msg,
  };
}

/**
 * Look at pictures. Returns plain text.
 *
 * Ollama takes images as base64 on the MESSAGE, not as content blocks — no
 * data URL prefix, no media type, just the payload. Sending a data URL is
 * accepted and produces a confident description of nothing, which is the worst
 * possible failure for something whose whole job is to report what is there.
 *
 * No tools, deliberately. A vision model handed a tool schema will sometimes
 * answer the picture with a function call, and this exists to produce a
 * sentence the model that DOES hold the tools can act on.
 */
export async function see({ images, prompt, model = CONFIG.visionModel, signal }) {
  const clean = (Array.isArray(images) ? images : [images])
    .filter(Boolean)
    .map((b) => String(b).replace(/^data:[^;]+;base64,/, ""));
  if (!clean.length) throw new Error("no images");

  const { text } = await chat({
    model,
    messages: [{ role: "user", content: prompt, images: clean }],
    temperature: 0.2,
    signal,
  });
  return text;
}

/** Whether the eyes are actually installed. Asked before promising sight. */
export async function visionReady() {
  try {
    const r = await fetch(`${CONFIG.ollama}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const names = ((await r.json()).models || []).map((m) => m.name);
    return names.includes(CONFIG.visionModel) ||
           names.some((n) => n.split(":")[0] === CONFIG.visionModel.split(":")[0]);
  } catch { return false; }
}

/**
 * Cheap one-shot with no tools, for classification and naming. Uses the 8B
 * gate model — running a 33B to pick a filename is a waste of the queue that
 * the real answer is waiting in.
 */
export async function quick(prompt, { system = "", maxWords = 40 } = {}) {
  const messages = system ? [{ role: "system", content: system }, { role: "user", content: prompt }]
                          : [{ role: "user", content: prompt }];
  const { text } = await chat({ messages, model: CONFIG.gateModel, temperature: 0.2 });
  return text.split(/\s+/).slice(0, maxWords).join(" ").trim();
}

// Belt and braces alongside think:false. Reasoning models sometimes emit the
// monologue inline anyway, and it must never reach a note Grayson reads.
function stripReasoning(s) {
  return String(s || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

/** Liveness, so the server can say which layer is down instead of just failing. */
export async function health() {
  try {
    const r = await fetch(`${CONFIG.ollama}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, detail: `ollama ${r.status}` };
    const models = (await r.json()).models || [];
    const names = models.map((m) => m.name);
    return {
      ok: names.includes(CONFIG.model),
      detail: names.includes(CONFIG.model) ? `${CONFIG.model} present` : `${CONFIG.model} NOT pulled`,
      models: names,
    };
  } catch (e) {
    return { ok: false, detail: `ollama unreachable: ${e.message}` };
  }
}
