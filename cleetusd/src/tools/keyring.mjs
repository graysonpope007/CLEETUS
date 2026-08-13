// src/tools/keyring.mjs — the model's side of the key store.
//
// See keyring.mjs for the property these are built around: a value enters over
// any origin and leaves only into this model's context. There is no HTTP route
// that returns one, which is why these tools are the only readback path.

import * as keyring from "../keyring.mjs";

export const keyringTools = {
  list_secrets: {
    schema: {
      description:
        "List the keys, tokens and passwords Grayson has given you, by NAME. Returns names, notes " +
        "and a four-character hint of each value, never the values themselves. Call this before " +
        "telling him you cannot do something for lack of a key, and before asking him for one — " +
        "he may have already handed it to you.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const held = await keyring.list();
      if (!held.length) {
        return "You are not holding any secrets yet. He can add one on the Reach page under Keys " +
               "and secrets, or tell you the value and you can save it with save_secret.";
      }
      return held
        .map((k) => `${k.name}${k.note ? ` — ${k.note}` : ""}  [${k.hint}]` +
                    (k.used ? `  used ${k.used}x` : "  never used"))
        .join("\n");
    },
  },

  get_secret: {
    schema: {
      description:
        "Read the actual value of one of Grayson's saved keys so you can USE it — put it in an " +
        "Authorization header, pass it to a command, sign a request. Also resolves names from his " +
        "shared cleetus.env. Never print the value into your reply and never write it into a file: " +
        "use it and talk about it by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The name it was saved under, e.g. OPENAI_API_KEY." } },
        required: ["name"],
      },
    },
    async run({ name }) {
      const hit = await keyring.get(name);
      if (!hit) {
        const held = await keyring.list();
        return `No secret called "${name}". ` +
          (held.length ? `You hold: ${held.map((k) => k.name).join(", ")}.` : "You are not holding any.") +
          ` If he needs to add it, the Reach page has a form for it under Keys and secrets.`;
      }
      return `${String(name).toUpperCase()} = ${hit.value}\n\n` +
        `(from ${hit.source}${hit.note ? `; note: ${hit.note}` : ""}. Use it. Do not repeat the value ` +
        `back to him — he already has it, and it would land in the run log.)`;
    },
  },

  save_secret: {
    schema: {
      description:
        "Save a key, token or password Grayson just gave you, so it survives this conversation. " +
        "Use the moment he says one out loud. Give it the name the service actually uses " +
        "(OPENAI_API_KEY, not 'the openai one') so it is findable later.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Upper snake case, the name the service uses." },
          value: { type: "string", description: "The secret itself, exactly as he gave it." },
          note: { type: "string", description: "One line: what it is for, and any scope or expiry he mentioned." },
        },
        required: ["name", "value"],
      },
    },
    async run({ name, value, note }) {
      try {
        const r = await keyring.put(name, value, { note });
        return `Saved ${r.name} [${r.hint}]${r.replaced ? ", replacing the one that was there" : ""}. ` +
               `It is on this Mac only, in a 0600 file, and no web route can read it back. ` +
               `Tell him it is saved and, if this was typed into the chat, that he may want to clear it ` +
               `from wherever he copied it.`;
      } catch (e) {
        return `Could not save that: ${e.message}`;
      }
    },
  },

  forget_secret: {
    schema: {
      description: "Delete a saved key. Use when he says one has been rotated or revoked.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    async run({ name }) {
      return (await keyring.remove(name))
        ? `Deleted ${String(name).toUpperCase()} from the keyring. If it also lives in cleetus.env it is still there — that file is his, and you do not write to it.`
        : `There is no saved secret called "${name}".`;
    },
  },
};
