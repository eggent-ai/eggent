/**
 * A Telegram message whose turn fails is answered, once, and not run again.
 *
 * Run with Node 22: npm run test:telegram-failure
 *
 * When the model or provider failed, the Telegram handler rethrew. Polling then
 * ran the whole turn twice more and skipped the update, a webhook answered 500
 * and Telegram delivered it again, and the person saw a bot that had gone quiet
 * while the runtime's own explanation sat in the container log (issue #26).
 *
 * The second half runs the real handler in a throwaway working directory. The
 * turn it starts is a stub that fails or answers as each case says, and
 * Telegram's API is a stub that records what would have been sent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentFailureText, MAX_FAILURE_REPLY_CHARS } from "../src/lib/telegram/failure-reply.ts";

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("The sentence a failed turn is answered with\n");

const FALLBACK = "Failed to process the message.";

await check("the runtime's own sentence reaches the person unchanged", () => {
  const sentence =
    'The provider answered, but does not offer the model "vendor/gone-model". It offers: vendor/other-model.';
  assert.equal(agentFailureText(new Error(sentence), FALLBACK), sentence);
});

await check("keys and tokens are cut out of it", () => {
  const text = agentFailureText(
    new Error("401 Unauthorized: Bearer abcdefghijklmnop, key sk-test1234567890abcdef, bot 123456789:AAabcdefghijklmnopqrstuvwxyz0123"),
    FALLBACK
  );
  assert.doesNotMatch(text, /abcdefghijklmnop|sk-test1234567890abcdef|AAabcdefghijklmnopqrstuvwxyz/);
  assert.match(text, /\[redacted\]/);
});

await check("a whole document as a message is cut to a readable length", () => {
  const text = agentFailureText(new Error(`{"error":"${"x".repeat(5000)}"}`), FALLBACK);
  assert.ok(text.length <= MAX_FAILURE_REPLY_CHARS, `got ${text.length} characters`);
  assert.ok(text.endsWith("…"));
});

await check("nothing to say falls back to the general sentence", () => {
  assert.equal(agentFailureText(new Error("   "), FALLBACK), FALLBACK);
  assert.equal(agentFailureText(undefined, FALLBACK), FALLBACK);
  assert.equal(agentFailureText({ weird: true }, FALLBACK), FALLBACK);
});

await check("a plain string is used as it is", () => {
  assert.equal(agentFailureText("Model is not available.", FALLBACK), "Model is not available.");
});

console.log("\nThe real handler, around a turn that fails\n");

// The Telegram handler runs for real in a throwaway working directory; the turn
// it starts is replaced (scripts/stubs/handle-external-message.ts) so each case
// decides how that turn ends, and Telegram's API is a stub that records what
// would have been sent.
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-telegram-failure-"));
process.chdir(workdir);
process.env.PI_CODING_AGENT_DIR = path.join(workdir, "data", "pi-agent");

type Sent = { method: string; body: Record<string, unknown> };
const sent: Sent[] = [];
let failSendMessage = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.telegram.org/")) return realFetch(input, init);
  const method = url.split("/").pop() || "";
  let body: Record<string, unknown> = {};
  try {
    body = init?.body ? JSON.parse(String(init.body)) : {};
  } catch {
    body = {};
  }
  sent.push({ method, body });
  if (failSendMessage && method === "sendMessage") {
    return new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { processTelegramUpdate } = await import("../src/lib/telegram/telegram-message-handler.ts");
const { ExternalMessageError } = await import("@/lib/external/handle-external-message");

const BOT_TOKEN = "123456789:AAtest-token-for-a-local-test-only-00000";
const runtime = {
  botToken: BOT_TOKEN,
  webhookSecret: "",
  publicBaseUrl: "",
  defaultProjectId: "",
  allowedUserIds: ["42"],
  mode: "polling",
  pollingInterval: 1000,
  detectedMode: "polling",
  sources: { botToken: "env", webhookSecret: "env", mode: "env" },
};
let nextUpdateId = 1000;
function update(text = "hello") {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: { message_id: nextUpdateId, date: 0, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Test" }, text },
  };
}
function setTurn(turn: { error?: unknown; reply?: string }) {
  (globalThis as { __eggentTestTurn?: unknown }).__eggentTestTurn = turn;
}
async function run(u: ReturnType<typeof update>) {
  const before = sent.length;
  try {
    const result = (await processTelegramUpdate(u as never, runtime as never)) as unknown as Record<string, unknown>;
    return { result, error: null as unknown, messages: sent.slice(before).filter((entry) => entry.method === "sendMessage") };
  } catch (error) {
    return { result: null, error, messages: sent.slice(before).filter((entry) => entry.method === "sendMessage") };
  }
}

const REFUSAL =
  'The provider answered, but does not offer the model "vendor/gone-model". It offers: vendor/other-model. Key sk-test1234567890abcdef was sent.';
setTurn({ error: new Error(REFUSAL) });
const failedUpdate = update();
const failed1 = await run(failedUpdate);

await check("a turn that fails does not throw, so polling and webhooks do not run it again", () => {
  assert.equal(failed1.error, null, `threw: ${failed1.error instanceof Error ? failed1.error.message : String(failed1.error)}`);
  assert.equal(failed1.result?.ok, true);
  assert.equal(failed1.result?.handledError, true);
});

await check("the person gets exactly one message, and it is the runtime's sentence", () => {
  assert.equal(failed1.messages.length, 1, `sendMessage calls: ${failed1.messages.length}`);
  assert.equal(String(failed1.messages[0].body.chat_id), "42");
  const text = String(failed1.messages[0].body.text || "");
  assert.match(text, /does not offer the model/);
  assert.match(text, /vendor\/other-model/);
});

await check("and nothing secret rides along", () => {
  const text = String(failed1.messages[0].body.text || "");
  assert.doesNotMatch(text, /sk-test1234567890abcdef/);
  assert.doesNotMatch(text, /AAtest-token-for-a-local-test-only/);
});

await check("the same update delivered again is not run again", async () => {
  const again = await run(failedUpdate);
  assert.equal(again.result?.duplicate, true);
  assert.equal(again.messages.length, 0, "a second delivery sent something");
});

await check("a structured refusal is still relayed as it was", async () => {
  setTurn({ error: new ExternalMessageError(402, { error: "The balance is spent." }) });
  const structured = await run(update());
  assert.equal(structured.result?.handledError, true);
  assert.equal(structured.result?.status, 402);
  assert.equal(structured.messages.length, 1);
  assert.match(String(structured.messages[0].body.text || ""), /The balance is spent\./);
});

await check("a turn that answers is delivered as before", async () => {
  setTurn({ reply: "Here is the answer." });
  const answered = await run(update());
  assert.equal(answered.error, null);
  assert.equal(answered.result?.ok, true);
  assert.equal(answered.result?.handledError, undefined);
  assert.equal(answered.messages.length, 1);
  assert.match(String(answered.messages[0].body.text || ""), /Here is the answer\./);
});

await check("when Telegram itself cannot be reached the update still fails, so it is retried", async () => {
  setTurn({ reply: "Here is the answer." });
  failSendMessage = true;
  const flaky = update();
  const first = await run(flaky);
  failSendMessage = false;
  assert.ok(first.error, "a failed delivery was treated as done");
  const retry = await run(flaky);
  assert.equal(retry.error, null);
  assert.equal(retry.result?.duplicate, undefined, "the retry was taken for a duplicate");
  assert.equal(retry.messages.length, 1);
});

globalThis.fetch = realFetch;
process.chdir(os.tmpdir());
fs.rmSync(workdir, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
