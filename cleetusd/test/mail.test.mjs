// Sending email, as Grayson, for real.
//
// He was asked how this should work and chose "send freely to anyone" over a
// draft-and-approve flow. The cloud endpoint was built for that; the local
// Cleetus — the half he actually talks to — had no way to send at all.
//
// There is deliberately no confirmation step in the tool. cleetusd is already
// the most privileged thing on this machine, and a prompt here would only train
// the model to answer its own prompt. The real protections live in the endpoint:
// a session, an append-only record written BEFORE the send, and a kill switch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolSchemas, callTool } from "../src/tools/index.mjs";

test("send_email exists and reaches the model", () => {
  assert.ok(TOOLS.send_email);
  const schema = toolSchemas().find((t) => t.function.name === "send_email");
  assert.ok(schema, "send_email is not in the schemas handed to Ollama");
  assert.deepEqual(schema.function.parameters.required, ["to", "subject", "body"]);
});

test("the description says it sends immediately", () => {
  // A model that thinks this drafts will use it casually. It must read as final.
  const d = TOOLS.send_email.schema.description.toLowerCase();
  assert.match(d, /immediately|no draft|for real/);
});

test("a name where an address belongs is refused, not sent", async () => {
  // The realistic mistake: the model writes the person instead of the address.
  const out = await callTool("send_email", { to: "Isaiah", subject: "hi", body: "hello" });
  assert.match(out, /not an email address/);
  assert.match(out, /Nothing was sent/);
});

test("missing pieces are named before anything leaves", async () => {
  const out = await callTool("send_email", { to: "a@b.com", subject: "hi" });
  assert.match(out, /missing a required argument/);
  assert.match(out, /body/);
});

test("the tool only ever talks to the send route", () => {
  // The kill switch lives in the cloud app's env. This tool must be able to
  // REPORT that sending is off — it names EMAIL_SEND_ENABLED in that message —
  // but it must not reach any route that could change it. (An earlier version of
  // this test grepped for the variable name and failed on its own error string:
  // the check was testing the message, not the behaviour.)
  const src = TOOLS.send_email.run.toString();
  const routes = [...src.matchAll(/\/api\/[a-z0-9/_-]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(routes)], ["/api/google/send"]);
});
