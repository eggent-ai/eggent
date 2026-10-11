/**
 * A turn that goes quiet is stopped, says so, and leaves the chat free.
 *
 * Drives the real runner against a stub provider that goes quiet in the two
 * ways that matter - a model that never answers, and a command that never ends
 * - and checks what the person is left with: a message that says what happened,
 * a stored turn that says the same, and a chat that can be written to again.
 * Also /reset: the same unsticking on request.
 *
 * Thresholds are set to a second so this does not take six minutes. No network,
 * no credential. Run with Node 22:
 *   npm run test:stalled-turn
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
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

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
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = payload.messages ?? [];
    const last = [...messages].reverse().find((message) => message.role === "user");
    const text = JSON.stringify(last?.content ?? "");
    const toolAnswered = messages[messages.length - 1]?.role === "tool";

    // A model that never answers: the request is taken and nothing comes back.
    if (text.includes("MODEL-HANG")) return;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    if (text.includes("TOOL-HANG") && !toolAnswered) {
      res.write(chunk({
        tool_calls: [{
          index: 0,
          id: "stub-bash-1",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "sleep 60" }) },
        }],
      }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ content: "all done" }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
provider.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-stalled-turn-"));
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
process.env.EGGENT_TURN_SILENCE_SOFT_SECONDS = "1";
process.env.EGGENT_TURN_SILENCE_MODEL_SECONDS = "3";
process.env.EGGENT_TURN_SILENCE_TOOL_SECONDS = "3";
process.env.EGGENT_TURN_WATCHDOG_TICK_MS = "100";

const { runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { getActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { getLiveRun } = await import("../src/lib/pi/live-run.ts");
const { resetChatTurn } = await import("../src/lib/pi/turn-control.ts");
import type { AgentProgressEvent } from "../src/lib/pi/types.ts";

const CHAT_MODEL = "11111111-1111-4111-8111-111111111111";
const CHAT_TOOL = "22222222-2222-4222-8222-222222222222";
const CHAT_RESET = "33333333-3333-4333-8333-333333333333";
const CHAT_FINE = "44444444-4444-4444-8444-444444444444";

for (const id of [CHAT_MODEL, CHAT_TOOL, CHAT_RESET, CHAT_FINE]) await createChat(id, "A chat");

const lastAssistant = async (chatId: string) =>
  (await getChat(chatId))?.messages.filter((message) => message.role === "assistant").pop()?.content ?? "";

console.log("A turn that goes quiet\n");

const events: AgentProgressEvent[] = [];
const started = Date.now();
const modelReply = await runPiAgentText({
  chatId: CHAT_MODEL,
  userMessage: "MODEL-HANG please",
  onProgress: (event) => events.push(event),
});
const modelSeconds = (Date.now() - started) / 1000;

await check("a model that stops answering is given up on within seconds, not minutes", () => {
  assert.ok(modelSeconds < 20, `took ${modelSeconds}s`);
});
await check("the answer says what happened and what to do", () => {
  assert.match(modelReply, /nothing had happened for \d+ min/);
  assert.match(modelReply, /write again|\/new/);
});
await check("the same words are in the stored chat, so the web shows them too", async () => {

  assert.equal(await lastAssistant(CHAT_MODEL), modelReply);
});
await check("the surface was told it was quiet before it was stopped", () => {
  assert.ok(events.some((event) => event.type === "silent" && event.active), JSON.stringify(events));
});
await check("and the chat is free: nothing is left running in it", () => {
  assert.equal(getActiveRun(CHAT_MODEL), undefined);
  assert.equal(getLiveRun(CHAT_MODEL), null);
});

const toolReply = await runPiAgentText({ chatId: CHAT_TOOL, userMessage: "TOOL-HANG please" });

await check("a command that never ends is stopped, and the answer says it was a command", () => {
  assert.match(toolReply, /command had been running for \d+ min/);
  assert.equal(getActiveRun(CHAT_TOOL), undefined);
});

console.log("\nStopping on request\n");

const waiting = runPiAgentText({ chatId: CHAT_RESET, userMessage: "MODEL-HANG then reset" });
await sleep(800);
const reset = await resetChatTurn(CHAT_RESET, { graceMs: 5000 });
const resetReply = await waiting;

await check("/reset finds the turn and stops it", () => {
  assert.equal(reset.found, true);
  assert.equal(reset.abandoned, false, "had to let go of a turn that should have stopped");
});
await check("the stopped turn does not claim to have failed", () => {
  assert.doesNotMatch(resetReply, /generation failed|no response/i);
  assert.equal(getActiveRun(CHAT_RESET), undefined);
  assert.equal(getLiveRun(CHAT_RESET), null);
});

console.log("\nNothing else changes\n");

const fine = await runPiAgentText({ chatId: CHAT_FINE, userMessage: "just answer" });
await check("a turn that keeps its word is left alone", () => {
  assert.equal(fine, "all done");
});

for (const socket of sockets) socket.destroy();
provider.close();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
