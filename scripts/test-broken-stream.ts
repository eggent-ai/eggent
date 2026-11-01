/**
 * A model answer cut off in the middle is asked for again, not left as an error.
 *
 * Run with Node 22: npm run test:broken-stream
 *
 * The hosted gateway relays the provider's stream; when that stream breaks
 * after the first bytes the workspace saw "OpenAI Responses stream ended before
 * a terminal response event", stored it as the turn's end and waited for the
 * person to type the request again (18 times in one week, 10 of them for one
 * paying workspace). The runtime retries this error by itself, so the turn
 * should carry on. Runs the real chat stream and the messenger runner against
 * a local stub on the Responses dialect.
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
const ANSWER = "The purchase table is ready.";
const calls = new Map<string, number>();

function textOf(input: unknown): string {
  if (!Array.isArray(input)) return "";
  for (const item of input as Array<Record<string, unknown>>) {
    if (item.role !== "user") continue;
    const content = item.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => String((part as { text?: string }).text ?? "")).join("");
  }
  return "";
}

const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
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
    const payload = JSON.parse(body || "{}") as Record<string, unknown>;
    const first = textOf(payload.input);
    const key = first.split(" ")[0];
    const attempt = (calls.get(key) ?? 0) + 1;
    calls.set(key, attempt);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const response = { id: `resp-${attempt}`, object: "response", status: "in_progress", model: MODEL, output: [] };
    const item = { id: "msg-1", type: "message", status: "in_progress", role: "assistant", content: [] };
    res.write(sse({ type: "response.created", response }));
    res.write(sse({ type: "response.output_item.added", output_index: 0, item }));
    const broken = key === "ALWAYS" || attempt === 1;
    if (broken) {
      res.write(sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg-1", delta: "The purch" }));
      // CUT ends the body cleanly with no terminal event; DROP kills the socket.
      if (key === "DROP") res.socket?.destroy();
      else res.end();
      return;
    }
    const done = { ...item, status: "completed", content: [{ type: "output_text", text: ANSWER }] };
    res.write(sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg-1", delta: ANSWER }));
    res.write(sse({ type: "response.output_item.done", output_index: 0, item: done }));
    res.write(sse({ type: "response.completed", response: { ...response, status: "completed", output: [done],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } }));
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-broken-stream-"));
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
      api: "openai-responses",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
    },
  },
}, null, 2));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }, null, 2));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: PROVIDER,
  defaultModel: MODEL,
  packages: [],
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 },
}, null, 2));

const { createPiChatUIMessageStream, runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");

async function webTurn(chatId: string, userMessage: string): Promise<string> {
  await createChat(chatId, userMessage);
  const reader = createPiChatUIMessageStream({ chatId, userMessage, cwd, agentDir, runId: `run-${chatId}` }).getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  const chat = await getChat(chatId);
  return chat?.messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n") ?? "";
}

console.log("web chat:");
const cut = await webTurn("00000001-2222-4333-8444-555566667777", "CUT make the purchase table");
await check("a stream that ends with no terminal event is asked for again and answers", () => {
  assert.equal(calls.get("CUT"), 2, `the provider was called ${calls.get("CUT")} time(s)`);
  assert.ok(cut.includes(ANSWER), `stored ${JSON.stringify(cut)}`);
});

const dropped = await webTurn("00000002-2222-4333-8444-555566667777", "DROP make the purchase table");
await check("a stream whose connection drops is asked for again and answers", () => {
  assert.equal(calls.get("DROP"), 2, `the provider was called ${calls.get("DROP")} time(s)`);
  assert.ok(dropped.includes(ANSWER), `stored ${JSON.stringify(dropped)}`);
});

const always = await webTurn("00000003-2222-4333-8444-555566667777", "ALWAYS make the purchase table");
await check("a stream that keeps breaking stops after the retries and says so", () => {
  assert.equal(calls.get("ALWAYS"), 3, `the provider was called ${calls.get("ALWAYS")} time(s)`);
  assert.ok(always.trim().length > 0, "the answer was stored empty");
});

console.log("\nmessenger:");
await createChat("00000004-2222-4333-8444-555566667777", "Telegram");
calls.delete("CUT");
const reply = await runPiAgentText({ chatId: "00000004-2222-4333-8444-555566667777", userMessage: "CUT from telegram", cwd, agentDir });
await check("a messenger's turn is asked for again too", () => {
  assert.equal(calls.get("CUT"), 2, `the provider was called ${calls.get("CUT")} time(s)`);
  assert.ok(reply.includes(ANSWER), `the reply was ${JSON.stringify(reply)}`);
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
