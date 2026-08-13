// src/keyring.mjs — somewhere to hand Cleetus a key.
//
// There was nowhere. The 90-key cleetus.env is READ AND NEVER WRITTEN by
// design (config.mjs), it belongs to the whole stack rather than to Cleetus,
// and editing it means opening a file in another app and restarting a daemon.
// So the way to give the local model an API key was to paste it into the chat,
// where it lands in a run file in plain text, scrolls out of the window in
// twelve messages, and is gone by tomorrow.
//
// THE ONE PROPERTY THIS FILE IS BUILT AROUND
// A secret VALUE may enter over any origin and may only ever leave into the
// local model's context. There is no HTTP route that returns one — not on
// loopback, not with the bearer, not for the dashboard. `list()` returns names
// and hints; only `get()` returns a value and only in-process callers have it.
//
// That asymmetry is deliberate and it is what makes the /reach form safe to use
// from a phone over the tunnel: writing a key from the sofa is useful, and a
// readback route would put every key Grayson owns one auth bug away from the
// open internet. If he needs to SEE a key he opens the file, which is the point
// of keeping it as a file.
//
// AT REST it is a 0600 JSON file under ~/cleetus-memory. Not encrypted, and
// that is honest rather than lazy: the decryption key would have to live beside
// it for a launchd daemon to start unattended, which is a lock with the key
// taped to it. The real boundary is the disk — FileVault — plus the fact that
// this never goes near iCloud.

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG, secrets as envSecrets } from "./config.mjs";

const FILE = join(CONFIG.memoryRoot, "keyring.json");

/**
 * One canonical name per secret.
 *
 * Everything that is not a letter or a digit becomes an underscore. That is
 * blunter than it looks and it is deliberate: the model writes the same key as
 * OPENAI_API_KEY, openai-api-key and "openai api key" depending on the
 * sentence, and a store that treats those as three different secrets answers
 * "no secret called that" while holding it. The first version kept dashes and
 * dots as themselves, which is exactly the case that failed.
 *
 * Collapsed and trimmed so "openai  api  key" and "OPENAI_API_KEY_" land on
 * the same name as well.
 */
const clean = (s) =>
  String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function load() {
  const raw = await readFile(FILE, "utf8").catch(() => null);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function save(all) {
  await mkdir(CONFIG.memoryRoot, { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2), "utf8");
  // Written every time, not once at creation. A file created by an earlier
  // build, restored from a backup, or copied by hand carries whatever mode it
  // arrived with, and a 0644 keyring is not a keyring.
  await chmod(FILE, 0o600).catch(() => {});
}

/**
 * Enough of a value to recognise it, never enough to use it.
 *
 * Four leading characters because that is where the shape lives — sk-, ghp_,
 * AKIA, pk_live — which is what makes "I already have that one, and it is a
 * publishable key not a secret one" a sentence Cleetus can say.
 */
export function hintOf(value) {
  const v = String(value || "");
  if (!v) return "";
  if (v.length <= 8) return `${v.length} chars`;
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

/** Names, notes and hints. Never a value — see the header. */
export async function list() {
  const all = await load();
  return Object.entries(all)
    .map(([name, e]) => ({
      name,
      note: e.note || "",
      hint: hintOf(e.value),
      saved: e.saved || "",
      used: e.used || 0,
      last_used: e.last_used || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function put(name, value, { note = "" } = {}) {
  const key = clean(name);
  if (!key) throw new Error("a secret needs a name");
  if (!String(value || "").length) throw new Error("a secret needs a value");
  const all = await load();
  const existed = !!all[key];
  all[key] = {
    value: String(value),
    note: note || all[key]?.note || "",
    saved: new Date().toISOString(),
    used: all[key]?.used || 0,
    last_used: all[key]?.last_used || null,
  };
  await save(all);
  return { name: key, replaced: existed, hint: hintOf(value) };
}

export async function remove(name) {
  const key = clean(name);
  const all = await load();
  if (!all[key]) return false;
  delete all[key];
  await save(all);
  return true;
}

/**
 * The value. IN-PROCESS ONLY.
 *
 * Falls through to the shared env file, so a key that is already in
 * cleetus.env — SITE_PASSWORD, the Plaid credentials, LLM_API_KEY — resolves
 * by the same name without being copied into a second place to go stale. The
 * keyring wins on a collision, because a key put there deliberately is the
 * newer intent.
 */
export async function get(name) {
  const key = clean(name);
  const all = await load();
  if (all[key]) {
    all[key].used = (all[key].used || 0) + 1;
    all[key].last_used = new Date().toISOString();
    await save(all).catch(() => {});
    return { value: all[key].value, source: "keyring", note: all[key].note || "" };
  }
  if (envSecrets[key]) return { value: envSecrets[key], source: CONFIG.envFile, note: "" };
  return null;
}

/** What goes in the system prompt: the names he holds, and nothing else. */
export async function keyringRoster() {
  const held = await list();
  if (!held.length) return "";
  return (
    `You are holding ${held.length} secret${held.length === 1 ? "" : "s"} for him, by name:\n` +
    held.map((k) => `- ${k.name}${k.note ? ` — ${k.note}` : ""} (${k.hint})`).join("\n") +
    `\nRead one with get_secret when a task actually needs it. Never print a secret value back to ` +
    `him in a message, never write one into a file he did not ask you to write, and never send one ` +
    `anywhere except the API it belongs to.`
  );
}
