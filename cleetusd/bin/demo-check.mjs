#!/usr/bin/env node
// bin/demo-check.mjs — would this survive being shown to somebody?
//
//   node bin/demo-check.mjs            the whole rehearsal
//   node bin/demo-check.mjs --quick    skip the ones that call the model
//
// tools-check.mjs asks whether each tool works when called directly. That is a
// different question from whether CLEETUS works, and the gap between them is
// where a demo dies: every tool green, and then he is asked "what's on my desk"
// and answers from memory because the router sent it somewhere odd, or the
// answer arrives with a heading in it, or he says he cannot do something he
// just did.
//
// So this drives the real path — the same HTTP route the Reach page uses — with
// the questions somebody would actually ask, and checks the ANSWER rather than
// the tool. Each case says which tool it should have reached and what the reply
// has to contain to count.
//
// The failure this exists to catch is the one that only appears in front of an
// audience: an answer that is fluent, confident, and about nothing.

const BASE = process.env.CLEETUSD_URL || "http://127.0.0.1:8767";
const quick = process.argv.includes("--quick");

const CASES = [
  {
    ask: "can you access my github repos",
    wants: "list_repos",
    // Names a repo that is genuinely only on GitHub. A model answering from
    // priors cannot produce this string.
    ok: (a) => /cleetus-auth|not cloned|working tree/i.test(a),
    why: "should name the uncloned repo rather than offering to look",
  },
  {
    ask: "what is on my desk right now",
    wants: "look",
    ok: (a) => !/cannot|don't have|unable|\[object/i.test(a) && a.length > 40,
    why: "should describe the frame, not decline",
  },
  {
    ask: "is anyone in the room with me",
    wants: "who_is_there",
    ok: (a) => !/cannot|don't have|unable|\[object/i.test(a),
    why: "should answer from the recogniser",
  },
  {
    ask: "how much free disk space do I have",
    wants: "run_shell",
    ok: (a) => /\d/.test(a),
    why: "should contain a real number",
  },
  {
    ask: "what branch is cleetusv2 on and is it clean",
    wants: "repo_status",
    ok: (a) => /main|branch|clean|uncommitted/i.test(a),
    why: "should read the repo, not guess",
  },
];

// Style rules from the system prompt, checked on every answer. These are the
// ones that make a demo look unfinished rather than wrong.
const STYLE = [
  [/^#{1,6} /m, "used a markdown heading"],
  [/^\s*[-*•]\s+/m, "used a bullet list"],
  [/^\s*\d+\.\s+/m, "used a numbered list"],
  [/—/, "used an em dash"],
  [/\[object Object\]/, "leaked [object Object] from a tool"],
];

async function ask(question, conversation) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question, conversation }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "", used = [], agent = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "step") used.push(ev.tool);
      else if (ev.type === "done") { answer = ev.answer || ""; used = ev.used || used; agent = ev.agent; }
      else if (ev.type === "error") answer = `ERROR: ${ev.error}`;
    }
  }
  return { answer, used, agent };
}

const fail = [];
const pass = [];

// ── the surfaces, before anything that costs a model call ──
for (const [name, path, check] of [
  ["health", "/health", (d) => d.ok === true],
  ["agents", "/agents", (d) => (d.agents || []).length >= 20],
  ["access", "/access", (d) => !!d.targets],
  ["repos", "/repos", (d) => (d.local || []).length > 10],
  ["conversations", "/conversations", (d) => Array.isArray(d.conversations)],
  ["secrets", "/secrets", (d) => Array.isArray(d.secrets)],
  ["skills", "/skills", (d) => Array.isArray(d.skills)],
  ["runs", "/runs", (d) => Array.isArray(d.runs)],
]) {
  try {
    const d = await fetch(BASE + path, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
    if (check(d)) { pass.push(`route ${name}`); console.log(`ok   route ${name}`); }
    else { fail.push([`route ${name}`, "answered but the shape is wrong"]); console.log(`FAIL route ${name}`); }
  } catch (e) {
    fail.push([`route ${name}`, e.message]);
    console.log(`FAIL route ${name}: ${e.message}`);
  }
}

// A value must never come back over HTTP. Asserted rather than assumed, because
// this is the one bug in the keyring that would be actively harmful.
try {
  const raw = await fetch(BASE + "/secrets").then((r) => r.text());
  if (/"value"/.test(raw)) {
    fail.push(["keyring is one-way", "GET /secrets returned a value field"]);
    console.log("FAIL keyring is one-way — a value came back over HTTP");
  } else { pass.push("keyring is one-way"); console.log("ok   keyring is one-way"); }
} catch (e) { fail.push(["keyring is one-way", e.message]); }

if (quick) {
  console.log(`\n${pass.length} passed, ${fail.length} failed (routes only)`);
  process.exit(fail.length ? 1 : 0);
}

// ── the conversation, end to end ──
const convo = `demo-check-${Date.now()}`;
console.log(`\nconversation ${convo}`);

for (const c of CASES) {
  const t0 = Date.now();
  let r;
  try { r = await ask(c.ask, convo); }
  catch (e) { fail.push([c.ask, e.message]); console.log(`FAIL "${c.ask}": ${e.message}`); continue; }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  const problems = [];
  if (c.wants && !r.used.includes(c.wants)) problems.push(`did not call ${c.wants} (called: ${r.used.join(", ") || "nothing"})`);
  if (!c.ok(r.answer)) problems.push(c.why);
  for (const [re, msg] of STYLE) if (re.test(r.answer)) problems.push(msg);

  if (problems.length) {
    fail.push([c.ask, problems.join("; ")]);
    console.log(`FAIL "${c.ask}" (${secs}s, ${r.agent})\n       ${problems.join("\n       ")}\n       answer: ${r.answer.replace(/\n/g, " ").slice(0, 160)}`);
  } else {
    pass.push(c.ask);
    console.log(`ok   "${c.ask}" (${secs}s, ${r.agent}, ${r.used.join("+") || "no tools"})`);
  }
}

// ── the thing the whole persistence rewrite exists for ──
// Asked in the SAME conversation, with no restatement of the subject. If the
// thread is not being replayed this cannot be answered, and the failure is
// silent: he answers something plausible about repos in general.
try {
  const r = await ask("which of those did you say was not cloned?", convo);
  if (/cleetus-auth/i.test(r.answer)) { pass.push("conversation memory"); console.log(`ok   conversation memory (${r.agent})`); }
  else { fail.push(["conversation memory", `lost the thread: ${r.answer.slice(0, 120)}`]); console.log("FAIL conversation memory"); }
} catch (e) { fail.push(["conversation memory", e.message]); }

// And that it survives a change of agent, which is the other half of the claim.
try {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "in one sentence, what have we been talking about?", conversation: convo, agent: "builder" }),
  });
  const text = await res.text();
  const done = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === "done");
  const a = done?.answer || "";
  if (/repo|github|clone|disk|desk/i.test(a)) { pass.push("thread survives an agent handoff"); console.log("ok   thread survives an agent handoff"); }
  else { fail.push(["agent handoff", `the specialist started cold: ${a.slice(0, 120)}`]); console.log("FAIL agent handoff"); }
} catch (e) { fail.push(["agent handoff", e.message]); }

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log("\nwhat to fix before showing anyone:");
  for (const [what, why] of fail) console.log(`  ${what}\n    ${why}`);
}
process.exit(fail.length ? 1 : 0);
