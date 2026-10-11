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
// What reached the model: how many requests, and the person's words in the last one.
let modelCalls = 0;
let lastUserTexts: string[] = [];
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
    modelCalls += 1;
    lastUserTexts = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content ?? ""));
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

// What a session does between being built and asking the model - compaction, the hooks of
// extensions - is time in which it does not yet report that it is running. This hook
// stands for it: it holds every turn up for as long as the test says.
const extensions = path.join(root, "data", "projects", ".pi", "extensions");
fs.mkdirSync(extensions, { recursive: true });
fs.writeFileSync(path.join(extensions, "preflight.ts"), [
  "export default function (pi) {",
  '  pi.on("before_agent_start", async () => {',
  "    const ms = Number(process.env.EGGENT_TEST_PREFLIGHT_MS || 0);",
  "    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));",
  "  });",
  "}",
  "",
].join("\n"));

const { runPiAgentText, joinActiveRun, createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { getActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { getLiveRun } = await import("../src/lib/pi/live-run.ts");
const { resetChatTurn } = await import("../src/lib/pi/turn-control.ts");
import type { AgentProgressEvent } from "../src/lib/pi/types.ts";

const CHAT_MODEL = "11111111-1111-4111-8111-111111111111";
const CHAT_TOOL = "22222222-2222-4222-8222-222222222222";
const CHAT_RESET = "33333333-3333-4333-8333-333333333333";
const CHAT_FINE = "44444444-4444-4444-8444-444444444444";

const CHAT_PRE_STOP = "55555555-5555-4555-8555-555555555555";
const CHAT_PRE_STEER = "66666666-6666-4666-8666-666666666666";
const CHAT_PRE_RESET = "77777777-7777-4777-8777-777777777777";
const CHAT_NOSAVE = "88888888-8888-4888-8888-888888888888";
const CHAT_WEBFAIL = "99999999-9999-4999-8999-999999999999";
const CHAT_EARLY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

for (const id of [CHAT_MODEL, CHAT_TOOL, CHAT_RESET, CHAT_FINE, CHAT_PRE_STOP, CHAT_PRE_STEER, CHAT_PRE_RESET, CHAT_NOSAVE, CHAT_WEBFAIL, CHAT_EARLY]) await createChat(id, "A chat");

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

console.log("\nA turn that is getting ready to ask the model\n");

// The session is built and the agent is not running yet: the hook holds it for two and a half seconds.
process.env.EGGENT_TEST_PREFLIGHT_MS = "2500";

modelCalls = 0;
const preStop = runPiAgentText({ chatId: CHAT_PRE_STOP, userMessage: "just answer" });
await sleep(1000);
const reachable = getActiveRun(CHAT_PRE_STOP);
const stopWord = reachable ? await joinActiveRun(CHAT_PRE_STOP, "stop") : null;
const preStopReply = await preStop;

await check("it can still be reached: the registry does not drop a turn that is only getting ready", () => {
  assert.ok(reachable, "the turn was not in the registry while its session got ready");
});
await check("a stop word reaches it, instead of starting a rival turn", () => {
  assert.equal(stopWord, "stopped");
});
await check("and it ends as soon as it can, without a word going to the model", () => {
  assert.equal(modelCalls, 0, `${modelCalls} request(s) reached the model after the stop`);
  assert.doesNotMatch(preStopReply, /all done/);
  assert.equal(getActiveRun(CHAT_PRE_STOP), undefined);
  assert.equal(getLiveRun(CHAT_PRE_STOP), null);
});

modelCalls = 0;
const preSteer = runPiAgentText({ chatId: CHAT_PRE_STEER, userMessage: "just answer" });
await sleep(1000);
const steered = await joinActiveRun(CHAT_PRE_STEER, "also mention the totals");
const steerReply = await preSteer;
await check("a message sent meanwhile is added to the turn, and the model hears it", () => {
  assert.equal(steered, "steered");
  assert.equal(steerReply, "all done");
  assert.ok(lastUserTexts.some((text) => text.includes("also mention the totals")), lastUserTexts.join(" | "));
});

modelCalls = 0;
const preReset = runPiAgentText({ chatId: CHAT_PRE_RESET, userMessage: "just answer" });
await sleep(1000);
const resetting = await resetChatTurn(CHAT_PRE_RESET, { graceMs: 6000 });
await preReset;
await check("/reset stops it for real, and says so only if it did", () => {
  assert.equal(resetting.found, true);
  assert.equal(resetting.abandoned, false, "the turn went on to ask the model after it was told it was freed");
  assert.equal(modelCalls, 0, `${modelCalls} request(s) reached the model after /reset`);
});
process.env.EGGENT_TEST_PREFLIGHT_MS = "0";

console.log("\nA turn that fails before it begins\n");

const chatFile = (id: string) => path.join(root, "data", "chats", `${id}.json`);
const asRoot = process.getuid?.() === 0;

await check("a chat that cannot be written to is not left registered as running (Telegram runner)", async () => {
  if (asRoot) {
    console.log("        (running as root: permissions do not apply, skipped)");
    return;
  }
  fs.chmodSync(chatFile(CHAT_NOSAVE), 0o444);
  try {
    await assert.rejects(runPiAgentText({ chatId: CHAT_NOSAVE, userMessage: "just answer" }));
    assert.equal(getActiveRun(CHAT_NOSAVE), undefined, "the failed turn is still registered");
    assert.equal(getLiveRun(CHAT_NOSAVE), null);
  } finally {
    fs.chmodSync(chatFile(CHAT_NOSAVE), 0o644);
  }
  const next = await joinActiveRun(CHAT_NOSAVE, "are you there");
  assert.equal(next, null, "the next message was added to a turn that was not running");
  assert.equal(await runPiAgentText({ chatId: CHAT_NOSAVE, userMessage: "just answer" }), "all done");
});
await check("a project list that cannot be read is not left registered as running either (web runner)", async () => {
  if (asRoot) {
    console.log("        (running as root: permissions do not apply, skipped)");
    return;
  }
  const projects = path.join(root, "data", "projects");
  fs.chmodSync(projects, 0o000);
  try {
    const stream = createPiChatUIMessageStream({ chatId: CHAT_WEBFAIL, userMessage: "@shop hello" } as never);
    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
    }
  } finally {
    fs.chmodSync(projects, 0o755);
  }
  assert.equal(getActiveRun(CHAT_WEBFAIL), undefined, "the failed turn is still registered");
  assert.equal(getLiveRun(CHAT_WEBFAIL), null);
  assert.equal(await joinActiveRun(CHAT_WEBFAIL, "are you there"), null);
});
await check("a turn stopped before it began says it was stopped, the way a stop later in the turn does", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome: { stopped?: boolean; finalText?: string } = {};
  const reply = await runPiAgentText({ chatId: CHAT_EARLY, userMessage: "just answer", abortSignal: controller.signal, outcome });
  assert.equal(outcome.stopped, true, "the caller cannot tell it was stopped, and says so a second time");
  assert.equal(reply, "", "the stop word's own answer is not said twice");
  assert.equal(getActiveRun(CHAT_EARLY), undefined);
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
