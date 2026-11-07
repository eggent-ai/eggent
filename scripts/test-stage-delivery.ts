/**
 * Whether the person sees the board of stages, through the real runners, a stub
 * model and a stand-in for the mcp proxy.
 *
 * A first job typed in the person's own words runs in the orchestrator, where
 * eggent_stage was not offered, so it could never draw a board. And a model that
 * sent a stage through the proxy was told the right name and sometimes went on
 * without it, for the whole job.
 *   npm run test:stage-delivery
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
const STAGE_ARGS = { id: "read", title: "Paper", status: "done", detail: "Read it", plan: [{ id: "read", title: "Paper" }, { id: "fields", title: "Fields" }] };

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub", object: "chat.completion.chunk", created: 0, model: MODEL,
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

/** Per word in the first message: the tools offered and what the model was told. */
const seen = new Map<string, { tools: string[]; toolMessages: string[] }>();

const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  let body = "";
  req.on("data", (part) => { body += String(part); });
  req.on("end", () => {
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
    const messages = payload.messages ?? [];
    const first = contentOf(messages.find((message) => message.role === "user"));
    const key = /([A-Z]{4,})/.exec(first)?.[1] ?? "";
    const toolMessages = messages.filter((message) => message.role === "tool").map(contentOf);
    seen.set(key, { tools: (payload.tools ?? []).map((tool) => tool.function?.name ?? ""), toolMessages });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    if (toolMessages.length === 0) {
      res.write(chunk({ tool_calls: [{ index: 0, id: `call-${key}`, type: "function", function: { name: "mcp", arguments: JSON.stringify(STAGE_ARGS) } }] }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ content: "Here is the result." }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-stage-delivery-"));
process.chdir(root);
const agentDir = path.join(root, "data", "pi-agent");
const cwd = path.join(root, "data", "projects");
const proxyRan = path.join(root, "proxy-ran");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".pi", "extensions", "fake-mcp.ts"), `
import fs from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "mcp", label: "mcp", description: "The proxy.",
    parameters: { type: "object", properties: { tool: { type: "string" }, id: {}, title: {}, status: {}, detail: {}, plan: {} } },
    execute: async () => { fs.writeFileSync(${JSON.stringify(proxyRan)}, "1"); return { content: [{ type: "text", text: "proxy status" }], details: {} }; },
  });
}
`);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_AUTH_SECRET = "stage-test-secret-0123456789abcdef";
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: { [PROVIDER]: { name: "Stub", baseUrl: providerUrl, api: "openai-completions", models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }] } },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, packages: [], retry: { enabled: false } }));

const { createPiChatUIMessageStream, runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");

type Chunk = { type: string; toolName?: string; output?: unknown; errorText?: string };
async function webTurn(chatId: string, userMessage: string): Promise<Chunk[]> {
  await createChat(chatId, userMessage);
  const chunks: Chunk[] = [];
  const reader = createPiChatUIMessageStream({ chatId, userMessage, cwd, agentDir, runId: `run-${chatId}` }).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value as Chunk);
  }
}

await check("a first job typed in the person's own words is offered stages", async () => {
  const chunks = await webTurn("11111111-1111-4111-8111-111111111111", "/skill:first-shift FIRSTJOB look at this");
  assert.ok(seen.get("FIRSTJOB")?.tools.includes("eggent_stage"));
  // The same call, sent through the proxy.
  const start = chunks.find((chunk) => chunk.type === "tool-input-available");
  assert.equal(start?.toolName, "eggent_stage", "the screen is told it is a stage");
  const output = chunks.find((chunk) => chunk.type === "tool-output-available");
  assert.ok(output, "and it did not end as an error");
  assert.ok(!chunks.some((chunk) => chunk.type === "tool-output-error"));
  assert.equal(JSON.parse(String(output?.output)).stage.id, "read");
  assert.ok(!fs.existsSync(proxyRan), "the proxy never ran");
  assert.match(seen.get("FIRSTJOB")!.toolMessages[0], /on the person's screen/, "the model has nothing to retry");
});

await check("the stored chat keeps it as a stage, so a reload draws the same board", async () => {
  const chat = await getChat("11111111-1111-4111-8111-111111111111");
  const tools = chat!.messages.flatMap((message) => (message.toolName ? [message] : []));
  const stage = tools.find((message) => message.toolName === "eggent_stage");
  assert.ok(stage, JSON.stringify(chat!.messages.map((message) => [message.role, message.toolName])));
  assert.ok(!tools.some((message) => message.toolName === "mcp"));
});

await check("a messenger's turn reports the finished stage as a stage", async () => {
  const events: Array<{ type: string; stage?: { id?: string } }> = [];
  await createChat("22222222-2222-4222-8222-222222222222", "/skill:first-shift TELEGRAM look at this");
  await runPiAgentText({
    chatId: "22222222-2222-4222-8222-222222222222",
    userMessage: "/skill:first-shift TELEGRAM look at this",
    cwd,
    agentDir,
    onProgress: (event: { type: string; stage?: { id?: string } }) => { events.push(event); },
  } as never);
  assert.equal(events.find((event) => event.type === "stage")?.stage?.id, "read");
});

await check("any other chat in the orchestrator does not pay for the tool, and the proxy stays the proxy", async () => {
  fs.rmSync(proxyRan, { force: true });
  const chunks = await webTurn("33333333-3333-4333-8333-333333333333", "PLAINCHAT what is new");
  assert.ok(!seen.get("PLAINCHAT")?.tools.includes("eggent_stage"));
  assert.equal(chunks.find((chunk) => chunk.type === "tool-input-available")?.toolName, "mcp");
  assert.ok(fs.existsSync(proxyRan), "the call was the proxy's");
});

await check("a chat that only mentions the skill is not a first job", async () => {
  await webTurn("44444444-4444-4444-8444-444444444444", "MENTION what does /skill:first-shift do");
  assert.ok(!seen.get("MENTION")?.tools.includes("eggent_stage"));
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall ok");
process.exit(failed ? 1 : 0);
