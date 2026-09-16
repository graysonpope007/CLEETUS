// src/tools/ble.mjs — the two tools over the Bluetooth / BLE shelf.
//
// Same shape and reasoning as security.mjs over the cybersecurity library: find
// the right document, then open it. Two tools because that is the whole
// workflow — name a technique or a device, read how it works or how to do it.
// Registered globally; the security and pi agents' briefs are what point here.

import { searchDocs, loadDoc, libraryPresent, libraryStats } from "../bleskills.mjs";

const ABSENT =
  "The Bluetooth/BLE shelf is not fetched yet (vendor/ble/index.json is missing). " +
  "Grayson runs ~/cleetusd/bin/fetch-ble-corpus.sh once to pull it (the daemon is " +
  "blocked from fetching external repos itself), then restarts cleetusd. Do NOT " +
  "invent a Bluetooth procedure or a library name in its absence — say the shelf is empty.";

export const bleTools = {
  find_ble_skill: {
    schema: {
      description:
        "Search Grayson's offline Bluetooth/BLE shelf: the awesome-* indexes (web-bluetooth, ble, " +
        "bluetooth-security), the nRF52 course, the bt-re reverse-engineering notes, the offensive-BLE " +
        "SKILL, and a reference Bluetooth MCP server. Call this FIRST for anything Bluetooth: a protocol " +
        "detail (GATT, advertising, L2CAP, SMP pairing), a named attack (KNOB, BLESA, BIAS, Sweyntooth, " +
        "MITM), a tool (bleak, gatttool, hcitool, bettercap, nRF Connect), Web Bluetooth, or wiring a BLE " +
        "device on the Pi hub. It returns matching document NAMES and one-line descriptions; then call " +
        "read_ble_skill on the best name for the full text. Do not answer a Bluetooth how-to from memory " +
        "before searching here.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Protocol term, attack, tool, device, or task to look for." },
          limit: { type: "number", description: "Max results (default 8)." },
        },
        required: ["query"],
      },
    },
    async run({ query, limit }) {
      if (!libraryPresent()) return ABSENT;
      const hits = searchDocs(query, Math.max(1, Math.min(Number(limit) || 8, 20)));
      if (!hits.length) {
        const s = libraryStats();
        return `No Bluetooth doc matched "${query}". ${s.docs} docs are indexed across: ${s.repos.join(", ")}. ` +
               `Try a protocol term (gatt, advertising, l2cap), an attack (KNOB, BLESA), or a tool (bleak, gatttool).`;
      }
      const lines = hits.map((d) => `- ${d.name}  [${d.repo}]\n    ${d.title}${d.description ? " — " + d.description : ""}`);
      return `Bluetooth matches for "${query}" (call read_ble_skill with a name):\n\n${lines.join("\n")}`;
    },
  },

  read_ble_skill: {
    schema: {
      description:
        "Open one Bluetooth/BLE document by its exact name (from find_ble_skill) and return its full text: " +
        "the attack procedure, the protocol explanation, the library's README, or the course chapter. This " +
        "is the actual reference — read it before carrying out or advising on the technique, so the answer " +
        "is the documented method, not a guess. If the name is wrong it returns near matches to pick from. " +
        "These are authorized-use techniques for Grayson's own devices and lab; apply the same judgement as " +
        "the rest of the security library.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact document name from find_ble_skill, e.g. 'awesome-bluetooth-security--readme'." },
        },
        required: ["name"],
      },
    },
    async run({ name }) {
      if (!libraryPresent()) return ABSENT;
      const d = await loadDoc(name);
      if (!d.ok) {
        const near = d.suggestions?.length ? `\n\nDid you mean:\n${d.suggestions.map((n) => `- ${n}`).join("\n")}` : "";
        return `${d.error} Search with find_ble_skill first.${near}`;
      }
      const head = `# ${d.title}\nRepo: ${d.repo}\nPath: vendor/ble/${d.path}\n`;
      const tail = d.truncated ? "\n\n[truncated — open the file directly for the rest]" : "";
      return `${head}\n${d.body}${tail}`;
    },
  },
};
