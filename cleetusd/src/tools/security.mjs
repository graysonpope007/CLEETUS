// src/tools/security.mjs — the security agent's reference bookshelf.
//
// Two tools over the 817-skill library (see ../secskills.mjs): find the right
// playbook, then open it. Kept to two because that is the whole workflow — the
// model does not need a "list domains" or "count skills" tool it would call to
// look busy; it needs to name a technique and read how to do or defend it.
//
// These are registered globally but MEAN something only to the security agent,
// whose brief tells it to reach here before answering. Any agent CAN call them;
// only one is told to. That mirrors how run_shell and read_file are shared —
// the tool is neutral, the brief supplies the judgement.

import { searchSkills, loadSkill, libraryPresent, libraryStats } from "../secskills.mjs";

const ABSENT =
  "The cybersecurity skill library is not installed (vendor/cybersecurity-skills is " +
  "missing). Clone it with: git clone https://github.com/mukul975/Anthropic-Cybersecurity-Skills " +
  "vendor/cybersecurity-skills — then this works. Do NOT invent a technique in its absence.";

export const securityTools = {
  find_security_skill: {
    schema: {
      description:
        "Search Grayson's offline cybersecurity playbook library (817 skills across 29 domains: " +
        "red-teaming, forensics, malware analysis, cloud, IAM, incident response, threat hunting, " +
        "AI security and more, each mapped to MITRE ATT&CK and NIST CSF). Call this FIRST whenever a " +
        "security question could have a documented procedure — an attack technique, a defence, a " +
        "forensic task, a hardening step, a compliance control. It returns matching skill NAMES and " +
        "one-line descriptions; then call read_security_skill on the best name to get the full " +
        "procedure. Search by technique, tool, or ATT&CK id (e.g. 'dpapi credential access', " +
        "'kubernetes audit logs', 'T1003', 'phishing email headers'). Do not answer a security " +
        "how-to from memory before searching here.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Technique, tool, threat, or ATT&CK id to look for.",
          },
          limit: { type: "number", description: "Max results (default 8)." },
        },
        required: ["query"],
      },
    },
    async run({ query, limit }) {
      if (!libraryPresent()) return ABSENT;
      const hits = searchSkills(query, Math.max(1, Math.min(Number(limit) || 8, 20)));
      if (!hits.length) {
        return `No skill matched "${query}". Try a technique name, a tool (nmap, mimikatz, ` +
               `volatility), or an ATT&CK id (T1003). ${libraryStats().skills} skills are indexed.`;
      }
      const lines = hits.map((s) => `- ${s.name}\n    ${s.description}`);
      return `Matches for "${query}" (call read_security_skill with a name):\n\n${lines.join("\n")}`;
    },
  },

  read_security_skill: {
    schema: {
      description:
        "Open one cybersecurity skill by its exact name (from find_security_skill) and return the " +
        "full procedure: overview, when to use, step-by-step commands, and its MITRE ATT&CK / NIST " +
        "CSF / D3FEND mappings. This is the actual playbook — read it before carrying out or advising " +
        "on the technique, so the answer is the documented method rather than a guess. If the name is " +
        "wrong it returns near matches to pick from.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Exact skill name, e.g. 'analyzing-email-headers-for-phishing-investigation'.",
          },
        },
        required: ["name"],
      },
    },
    async run({ name }) {
      if (!libraryPresent()) return ABSENT;
      const s = await loadSkill(name);
      if (!s.ok) {
        const near = s.suggestions?.length
          ? `\n\nDid you mean:\n${s.suggestions.map((n) => `- ${n}`).join("\n")}`
          : "";
        return `${s.error} Search with find_security_skill first.${near}`;
      }
      const m = s.meta || {};
      const map = [
        m.subdomain ? `Subdomain: ${m.subdomain}` : "",
        Array.isArray(m.mitre_attack) && m.mitre_attack.length ? `MITRE ATT&CK: ${m.mitre_attack.join(", ")}` : "",
        Array.isArray(m.nist_csf) && m.nist_csf.length ? `NIST CSF: ${m.nist_csf.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      return `# ${s.name}\n${map ? map + "\n" : ""}\n${s.body}`;
    },
  },
};
