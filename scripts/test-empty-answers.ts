/**
 * A turn never ends as an empty answer.
 *
 * Run with Node 22: npm run test:empty-answers
 *
 * Runs the real chat stream and the messenger runner against a local stub
 * provider. Three shapes used to leave the person looking at an empty bubble
 * after the agent had done real work: the model ending on its reasoning with
 * no text, the provider refusing after a few tool calls (stored as a success,
 * its reason kept only in the agent's session), and a stopped turn stored as
 * whatever it had written so far - which after silent tool calls is nothing.
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
const ANSWER = "The table is ready: purchase.xlsx, 2.01 t in all.";
const REFUSAL = "Key budget is spent: this request needs 184 and the key has 128 left";
const nudges: string[] = [];

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } } : {}),
  })}\n\n`;
}

function contentOf(message: { content?: unknown } | undefined): string {
  const value = message?.content;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => (part as { text?: string })?.text ?? "").join("");
  return "";
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
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = payload.messages ?? [];
    const first = contentOf(messages.find((message) => message.role === "user"));
    const last = messages[messages.length - 1];
    const toolResults = messages.filter((message) => message.role === "tool").length;
    const nudged = last?.role === "user" && contentOf(last).startsWith("[Eggent]");
    if (nudged) nudges.push(first);

    if (first.includes("REFUSE") && toolResults >= 1) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: REFUSAL, type: "insufficient_quota" } }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    if (toolResults === 0) {
      // Every scenario does one piece of work first, silently.
      const command = first.includes("STOP") ? "sleep 20" : "echo working";
      res.write(chunk({
        tool_calls: [{
          index: 0,
          id: "stub-bash-1",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command }) },
        }],
      }));
      res.write(chunk({}, "tool_calls"));
    } else if (nudged && !first.includes("MUTE")) {
      res.write(chunk({ content: ANSWER }));
      res.write(chunk({}, "stop"));
    } else {
      // Thought it through and wrote nothing.
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-empty-answers-"));
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
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: PROVIDER,
  defaultModel: MODEL,
  packages: [],
  retry: { enabled: false },
}, null, 2));

const { createPiChatUIMessageStream, runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { stopActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { whenLiveRunFinished } = await import("../src/lib/pi/live-run.ts");
const { translate } = await import("../src/i18n/messages.ts");

async function webTurn(chatId: string, userMessage: string, onStart?: () => Promise<void>): Promise<void> {
  await createChat(chatId, userMessage);
  const reader = createPiChatUIMessageStream({ chatId, userMessage, cwd, agentDir, runId: `run-${chatId}` }).getReader();
  const drained = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
  if (onStart) await onStart();
  await drained;
}

async function answerOf(chatId: string): Promise<string> {
  const chat = await getChat(chatId);
  assert.ok(chat, "the chat is gone");
  const assistants = chat.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 1, `expected one stored answer, found ${assistants.length}`);
  assert.equal(chat.messages.filter((message) => message.role === "user").length, 1, "the hidden ask was stored as the person's message");
  return assistants[0].content;
}

console.log("web chat:");

const SILENT = "00000001-1111-4222-8333-444455556666";
await webTurn(SILENT, "SILENT make the purchase table");
await check("a turn that did the work and wrote nothing is asked once more, and the answer is stored", async () => {
  assert.ok(nudges.includes("SILENT make the purchase table"), "the model was not asked again");
  assert.ok((await answerOf(SILENT)).includes(ANSWER), "the answer written on the second ask is missing");
});

const MUTE = "00000002-1111-4222-8333-444455556666";
await webTurn(MUTE, "MUTE make the purchase table");
await check("a model that stays silent when asked again leaves a line that says so", async () => {
  assert.equal(nudges.filter((first) => first.startsWith("MUTE")).length, 1, "expected exactly one more ask");
  assert.ok((await answerOf(MUTE)).includes(translate("en", "chat.errors.noFinalAfterTools")));
});

const REFUSED = "00000003-1111-4222-8333-444455556666";
await webTurn(REFUSED, "REFUSE make the purchase table");
await check("a provider that refuses after some work is quoted in the answer", async () => {
  const content = await answerOf(REFUSED);
  assert.ok(content.includes("Key budget is spent"), `the provider's reason is missing: ${JSON.stringify(content)}`);
  const chat = await getChat(REFUSED);
  assert.ok(chat?.messages.some((message) => message.role === "tool" && message.toolName === "bash"), "the work done before it was lost");
});

const STOPPED = "00000004-1111-4222-8333-444455556666";
await webTurn(STOPPED, "STOP make the purchase table", async () => {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const chat = await getChat(STOPPED);
    if (chat?.messages.some((message) => message.role === "assistant")) break;
    if (await stopActiveRun(STOPPED)) {
      await whenLiveRunFinished(STOPPED);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("nothing was running to stop");
});
await check("a stopped turn says it was stopped instead of being stored empty", async () => {
  assert.ok((await answerOf(STOPPED)).includes(translate("en", "external.run.stopped")));
  assert.ok(!nudges.some((first) => first.startsWith("STOP")), "a stopped turn was asked to answer");
});

console.log("\nmessenger:");

const TG_SILENT = "00000005-1111-4222-8333-444455556666";
await createChat(TG_SILENT, "Telegram");
const silentReply = await runPiAgentText({ chatId: TG_SILENT, userMessage: "SILENT from telegram", cwd, agentDir });
await check("a messenger's turn that wrote nothing is asked once more and answers", () => {
  assert.ok(silentReply.includes(ANSWER), `the reply was ${JSON.stringify(silentReply)}`);
});

const TG_REFUSED = "00000006-1111-4222-8333-444455556666";
await createChat(TG_REFUSED, "Telegram");
const refusedReply = await runPiAgentText({ chatId: TG_REFUSED, userMessage: "REFUSE from telegram", cwd, agentDir });
await check("a messenger's turn refused after some work carries the provider's reason", () => {
  assert.ok(refusedReply.includes("Key budget is spent"), `the reply was ${JSON.stringify(refusedReply)}`);
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
