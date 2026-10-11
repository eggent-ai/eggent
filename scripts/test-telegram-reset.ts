/**
 * /reset, and a message that only wants to reach a turn that is already working.
 *
 * Over Telegram there is no stop button, and the deployment's bot queues each
 * person's messages in order - so "stop" used to wait behind the very turn it
 * was meant to stop. This drives the real external-message handler and the real
 * runner against a stub model that never answers: /reset frees the chat and the
 * stopped turn says nothing more, a message sent only to *reach* a turn
 * (`controlOnly`) steers or stops it when there is one and does nothing at all
 * when there is not, and everything else still starts a turn as before.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:telegram-reset
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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

const PROVIDER = "stub";
const MODEL = "stub-model";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "stub-completion", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

let modelCalls = 0;
const sockets = new Set<import("node:net").Socket>();
const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  let body = "";
  req.on("data", (part) => {
    body += String(part);
  });
  req.on("end", () => {
    modelCalls += 1;
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
    // The newest thing the model was asked: earlier turns stay in the
    // conversation, and must not make a later one hang.
    const messages = payload.messages ?? [];
    const text = JSON.stringify([...messages].reverse().find((message) => message.role === "user")?.content ?? "");
    // The model that never answers.
    if (text.includes("MODEL-HANG")) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "all done" }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
provider.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-telegram-reset-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      api: "openai-completions",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
    },
  },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
delete process.env.EGGENT_TELEGRAM_RELAY_URL;

const { handleExternalMessage } = await import("../src/lib/external/handle-external-message.ts");
const { getActiveRun } = await import("../src/lib/pi/active-runs.ts");

const SESSION = "cloud-telegram:42";
const telegram = { telegram: { chatId: 42, replyToMessageId: null } };
const say = (message: string, extra: Record<string, unknown> = {}) =>
  handleExternalMessage({ sessionId: SESSION, message, telegramVia: "relay", toolRuntimeData: telegram, ...extra });

console.log("Nothing to stop\n");

await check("/reset with nothing running says so, and runs no model", async () => {
  const before = modelCalls;
  const result = await say("/reset");
  assert.match(result.reply, /Nothing is running/);
  assert.equal(modelCalls, before);
});

await check("a message that only wants to reach a turn does nothing when there is none", async () => {
  const before = modelCalls;
  const result = await say("also add the totals", { controlOnly: true });
  assert.equal(result.handled, false);
  assert.equal(result.reply, "");
  assert.equal(modelCalls, before, "it started a turn of its own");
});

console.log("\nA turn that never answers\n");

const turn = say("MODEL-HANG please");
await sleep(800);

await check("the turn is registered, and reachable", async () => {
  const { activeRunCount } = await import("../src/lib/pi/active-runs.ts");
  assert.ok(activeRunCount() >= 1, "no turn is registered after 800 ms");
});

await check("a message sent only to reach it is added to it, not queued behind it", async () => {
  // Said in the model's own terms so the turn it joins goes on hanging.
  const result = await say("MODEL-HANG also add the totals", { controlOnly: true });
  assert.notEqual(result.handled, false);
  assert.match(result.reply, /taking that into account/);
});

await check("/reset stops it, saying so, and keeps the conversation", async () => {
  const result = await say("/reset");
  assert.match(result.reply, /Stopped it/);
  assert.doesNotMatch(result.reply, /Nothing is running/);
});

const finished = await turn;

await check("the stopped turn has nothing more to say, so nothing is sent for it", () => {
  assert.equal(finished.stopped, true);
  assert.equal(finished.reply.trim(), "");
});

await check("and the chat is free again", () => {
  assert.equal(getActiveRun(finished.context.activeChatId), undefined);
});

console.log("\nThe stop word reaches it too\n");

const second = say("MODEL-HANG once more");
await sleep(800);
const stopWord = await say("stop", { controlOnly: true });
const secondFinished = await second;

await check("a stop word sent only to reach the turn stops it", () => {
  assert.match(stopWord.reply, /Stopped/);
  assert.equal(secondFinished.stopped, true);
  assert.equal(secondFinished.reply.trim(), "");
});

console.log("\nEverything else is as it was\n");

await check("an ordinary message still starts a turn and gets its answer", async () => {
  const result = await say("just answer");
  assert.equal(result.reply, "all done");
  assert.equal(result.stopped, undefined);
});

for (const socket of sockets) socket.destroy();
provider.close();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
