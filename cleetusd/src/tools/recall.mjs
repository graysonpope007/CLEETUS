// src/tools/recall.mjs — reading conversations that are not this one.
//
// The thread you are in is replayed into the prompt automatically. These are
// for the ones you are NOT in: "what did we decide about the Winchester map",
// asked three weeks later, in a different thread, possibly to a different
// agent. Facts he stated are in MEMORY.md; a conclusion reached over ten
// messages is not a fact anyone thought to write down, and this is the only way
// back to it.

import * as convos from "../conversations.mjs";

export const recallTools = {
  recall_chat: {
    schema: {
      description:
        "Search everything Grayson has ever said to you, across every past conversation and every " +
        "agent. Use when he refers to something you do not have in front of you — 'what we decided', " +
        "'the thing I told you about last week', a project or a name you do not recognise from this " +
        "thread. Search this BEFORE saying you do not remember something.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Words likely to appear in that conversation." } },
        required: ["query"],
      },
    },
    async run({ query }) {
      const hits = await convos.search(query, { limit: 4 });
      if (!hits.length) return `Nothing in your past conversations matches "${query}".`;
      return hits
        .map((h) => `## ${h.title}\n(${h.id}, with the ${h.agent} agent, last ${String(h.updated).slice(0, 16).replace("T", " ")})\n\n${h.excerpt}`)
        .join("\n\n---\n\n");
    },
  },

  read_chat: {
    schema: {
      description:
        "Read one past conversation in full, by its id. Use after recall_chat when the excerpt is not " +
        "enough, or when he names a conversation from the list on the Reach page.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The conversation id, e.g. 20260813-102341-9f2c" } },
        required: ["id"],
      },
    },
    async run({ id }) {
      const c = await convos.load(id);
      if (!c) {
        const recent = await convos.recentDigest(8);
        return `No conversation with id "${id}".` + (recent ? `\n\nThe recent ones are:\n${recent}` : "");
      }
      const body = c.messages
        .map((m) => `${m.role === "user" ? "Grayson" : (m.agent || c.agent || "cleetus")}: ` +
                    (typeof m.content === "string" ? m.content : "[image]"))
        .join("\n\n");
      return `# ${c.title || "Untitled"}\n(${c.id}, started ${String(c.created).slice(0, 16).replace("T", " ")})\n\n${body}`.slice(0, 60_000);
    },
  },
};
