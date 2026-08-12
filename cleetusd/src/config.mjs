// src/config.mjs — where everything is, and the few knobs worth having.
//
// WHY THIS PROCESS EXISTS
// The model was always on the Mac Studio. The AGENT was not: every message went
// browser -> Cloudflare Pages -> back down the tunnel -> Ollama -> back up. The
// worker is a sandbox with no disk, so Cleetus could reason about Grayson's
// files only if a human pasted them in. That is the whole reason he could not
// pick up work mid-flight.
//
// cleetusd puts the loop on the same machine as the model and the files. The
// web app becomes a face for this, not the thing itself.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

// The 90-key env the rest of the stack already uses. Read, never written.
const ENV_FILE = join(HOME, "Documents/Claude/Projects/Cleetus V2/cleetus.env");

function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);
const env = { ...fileEnv, ...process.env };

export const CONFIG = {
  home: HOME,
  envFile: ENV_FILE,

  // Ollama, spoken to natively rather than through the OpenAI-compatible shim.
  // Native /api/chat is the only surface where `think: false` is honoured —
  // the /v1 endpoint silently drops fields it does not recognise, which is how
  // a 500-token reasoning monologue once ate an entire 300-token brief.
  ollama: env.OLLAMA_HOST || "http://127.0.0.1:11434",
  model: env.CLEETUSD_MODEL || env.LLM_MODEL || "laguna-xs-2.1:q8_0",
  gateModel: env.LOCAL_GATE_MODEL || "lfm2.5:8b",

  // Where Grayson reads. Memory that lands anywhere else may as well not exist.
  vault: env.CLEETUS_VAULT ||
    join(HOME, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cleetus"),

  // Where Cleetus WRITES. Deliberately not in iCloud.
  //
  // OBSERVED, not theorised: the first time cleetusd started under launchd,
  // every request that touched the vault hung forever. Sampling the process
  // showed it parked in
  //     __opendir2 -> open$NOCANCEL -> __open_nocancel
  // on ~/Library/Mobile Documents, which the CloudDocs file provider serves.
  // $NOCANCEL means exactly what it says: the open cannot be interrupted, so
  // the request never returns and the thread never comes back. The identical
  // call from a terminal answered instantly.
  //
  // After a restart the same path read fine, so this is not a permanent denial
  // — it is a cold or evicted iCloud path blocking on first touch, and it will
  // happen again whenever the provider decides to evict. That is reason enough
  // not to put the daemon's own memory behind it: a personal assistant must
  // not stop working because a sync daemon is thinking.
  //
  // So writes go to a plain local directory. Symlink it into the vault if you
  // want the notes in Obsidian (see README); everything vault-side is now
  // time-boxed either way, so a block degrades instead of wedging.
  memoryRoot: env.CLEETUS_MEMORY_ROOT || join(HOME, "cleetus-memory"),

  // The per-agent standing briefs. These live in the web app's repo because
  // that half already loads them (functions/_lib/agents.js) and Grayson edits
  // them there; cleetusd reading the same files is what stops the two halves
  // drifting into different personalities for the same agent. It had already
  // started: 20 inline briefs here against 19 markdown files there.
  agentBriefs: env.CLEETUS_AGENT_BRIEFS || join(HOME, "cleetusv2/brain/agents"),

  runsDir: "runs",
  skillsDir: "skills",

  // Any single filesystem call that has not answered in this long is treated
  // as blocked. Nothing on a network or provider-backed path is allowed to
  // wedge the daemon.
  fsTimeoutMs: Number(env.CLEETUSD_FS_TIMEOUT_MS || 3000),

  // Loopback only. Exposure to the outside is the tunnel's job, gated by Caddy
  // with a bearer, exactly like llm.cleetusai.com and cleetus-web. Binding this
  // to 0.0.0.0 would put an unauthenticated shell on the LAN.
  host: "127.0.0.1",
  port: Number(env.CLEETUSD_PORT || 8767),
  token: env.CLEETUSD_TOKEN || env.CLEETUS_WEB_TOKEN || "",

  // The existing browser harness. Reads execute, commits queue — cleetusd does
  // not reimplement that, it delegates to it.
  //
  // LOOPBACK, and not CLEETUS_WEB_URL. That variable belongs to the deployed
  // app, which genuinely needs a public hostname to reach this Mac; it is set to
  // https://web.cleetusai.com, which is NXDOMAIN — that host was never added to
  // the tunnel ingress. cleetusd inherited the variable because it reads the
  // same env file, and so spent every browser call resolving a hostname that
  // does not exist, to reach a service running on its own machine.
  //
  // Same-machine services get addressed as same-machine services. The override
  // is cleetusd's own, so the cloud app's setting can never drag it off-box again.
  webHarness: env.CLEETUSD_WEB_URL || "http://127.0.0.1:8766",
  webToken: env.CLEETUS_WEB_TOKEN || "",

  // The deployed app, for the data that genuinely lives in the cloud: Plaid,
  // Schwab, Google Calendar, the ledger. No reason to reimplement those here.
  cloud: env.CLEETUS_CLOUD_URL || "https://cleetusai.com",
  sitePassword: env.SITE_PASSWORD || "",

  // Tool-loop ceiling. A loop that cannot end is worse than one that gives up.
  maxSteps: Number(env.CLEETUSD_MAX_STEPS || 12),

  // Kill switch for the shell tool specifically. Everything else stays usable.
  // Set CLEETUSD_NO_SHELL=1 to take the machine out of his hands without
  // stopping him answering questions.
  shellEnabled: env.CLEETUSD_NO_SHELL !== "1",
};

export const secrets = env;
