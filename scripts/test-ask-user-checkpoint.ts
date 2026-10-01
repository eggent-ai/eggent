/**
 * A web turn that stops to ask a question is in the stored chat while it
 * waits, and the finished turn replaces it.
 *
 * Run with Node 22: npm run test:ask-user-checkpoint
 *
 * Runs the real chat stream and session runtime against a local stub provider
 * whose first answer is an eggent_ask_user call. The stored chat used to hold
 * only the person's message for as long as a question waited, so a person who
 * left at the question came back, after the workspace slept, to nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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
const BEFORE = "I went through all 19 statements.";
const QUESTION = "When was the petition accepted?";
const AFTER = "Then three payments fall inside the look-back period.";

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

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
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string }> };
    const messages = payload.messages ?? [];
    const answered = messages[messages.length - 1]?.role === "tool";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    if (!answered) {
      res.write(chunk({ content: BEFORE }));
      res.write(chunk({
        tool_calls: [{
          index: 0,
          id: "stub-ask-1",
          type: "function",
          function: {
            name: "eggent_ask_user",
            arguments: JSON.stringify({ question: QUESTION, options: ["2026-03-01", "Not sure"] }),
          },
        }],
      }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ content: AFTER }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-ask-checkpoint-"));
process.chdir(root);
const agentDir = path.join(root, "data", "pi-agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: providerUrl,
      api: "openai-completions",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
    },
  },
}, null, 2));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }, null, 2));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, packages: [] }, null, 2));

const { createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { listPendingInteractions, respondToPendingInteraction } = await import("../src/lib/pi/pending-interactions.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { stopActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { whenLiveRunFinished } = await import("../src/lib/pi/live-run.ts");

const CHAT = "0000bbbb-1111-4222-8333-444455556666";
const RUN = "run-ask-checkpoint";
await createChat(CHAT, "Statements");

const stream = createPiChatUIMessageStream({
  chatId: CHAT,
  userMessage: "Go through the statements",
  cwd,
  agentDir,
  runId: RUN,
});
const reader = stream.getReader();
const drained = (async () => {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
})();

async function waitFor<T>(what: string, probe: () => Promise<T | null> | T | null, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pending = await waitFor("the question", () => listPendingInteractions(RUN)[0] ?? null);
const waiting = await waitFor("the checkpoint", async () => {
  const chat = await getChat(CHAT);
  return chat?.messages.some((message) => message.inProgress) ? chat : null;
}, 5_000).catch(() => null);

await check("while the question waits, the stored chat holds the turn so far", () => {
  assert.ok(waiting, "nothing but the person's message was stored");
  const roles = waiting.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant"]);
  const turn = waiting.messages[1];
  assert.equal(turn.inProgress, true);
  assert.ok(turn.content.includes(BEFORE), "the text before the question is missing");
  assert.ok(turn.content.includes(QUESTION), "the question itself is missing");
});

respondToPendingInteraction(RUN, pending.id, { value: "2026-03-01" });
await drained;

await check("the finished turn replaces the checkpoint instead of landing beside it", async () => {
  const chat = await getChat(CHAT);
  assert.ok(chat);
  const assistants = chat.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 1, `expected one answer, found ${assistants.length}`);
  assert.ok(!assistants[0].inProgress, "the answer is still marked in progress");
  assert.ok(assistants[0].content.includes(AFTER), "the end of the turn is missing");
  assert.ok(chat.messages.some((message) => message.role === "tool" && message.toolName === "eggent_ask_user"));
  assert.equal(chat.messages[0].role, "user");
});

// Stopping while the question waits: the composer offers Stop beside the
// card now, and it goes through the same endpoint as any other stop.
const STOPPED = "0000cccc-1111-4222-8333-444455556666";
const STOP_RUN = "run-ask-stop";
await createChat(STOPPED, "Statements, stopped");
const stopReader = createPiChatUIMessageStream({
  chatId: STOPPED,
  userMessage: "Go through the statements",
  cwd,
  agentDir,
  runId: STOP_RUN,
}).getReader();
const stopDrained = (async () => {
  for (;;) {
    const { done } = await stopReader.read();
    if (done) return;
  }
})();
await waitFor("the second question", () => listPendingInteractions(STOP_RUN)[0] ?? null);
const stopped = await stopActiveRun(STOPPED);
await Promise.race([
  (async () => {
    if (stopped) await whenLiveRunFinished(STOPPED);
    await stopDrained;
  })(),
  new Promise((_, reject) => setTimeout(() => reject(new Error("the turn did not end after stop")), 15_000)),
]).catch((error) => {
  failed += 1;
  console.log(`  FAIL  stopping a turn that waits on a question ends it: ${(error as Error).message}`);
});

await check("stop ends a turn that waits on a question and cancels the question", async () => {
  assert.equal(stopped, true, "nothing was running to stop");
  assert.equal(listPendingInteractions(STOP_RUN).length, 0, "the question is still waiting");
  const chat = await getChat(STOPPED);
  assert.ok(chat);
  const assistants = chat.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 1, `expected one stored turn, found ${assistants.length}`);
  assert.ok(!assistants[0].inProgress, "the stopped turn is still marked in progress");
  assert.ok(assistants[0].content.includes(BEFORE), "what the turn did before the question was lost");
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
