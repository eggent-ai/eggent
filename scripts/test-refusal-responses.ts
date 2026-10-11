/**
 * The answer a deployment's gateway writes in place of a model's, as the runtime
 * reads it on the dialect a workspace actually speaks.
 *
 * A scheduled run that is turned away looks like a success to everything that
 * reads the store: the reply is well formed, finishes normally and spent
 * nothing. The one thing that tells it apart is the id the gateway answers
 * under, and the host reads that id from `responseId` on the assistant message.
 * That field is filled in differently by each dialect, and workspaces speak
 * Responses, not chat completions - so this drives the runtime against the
 * exact event sequence the gateway writes, and checks the id arrives.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:refusal-responses
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const PROVIDER = "stub";
const MODEL = "stub-model";
const ID = "eggent_limit_1791700000000";
const SENTENCE = "Request not carried out: the limit for this workspace has been reached.";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The gateway's answer to a streamed /v1/responses request, event for event. */
function gatewayRefusal(): string {
  const itemId = `msg_${ID}`;
  const response = {
    id: ID,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: MODEL,
    output: [{
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: SENTENCE }],
    }],
    parallel_tool_calls: true,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  const item = response.output[0];
  const part = item.content[0];
  return [
    sse("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }),
    sse("response.in_progress", { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } }),
    sse("response.output_item.added", { type: "response.output_item.added", item: { id: itemId, type: "message", status: "in_progress", content: [], role: "assistant" }, output_index: 0, sequence_number: 1 }),
    sse("response.content_part.added", { type: "response.content_part.added", content_index: 0, item_id: itemId, output_index: 0, part: { type: "output_text", annotations: [], logprobs: [], text: "" }, sequence_number: 2 }),
    sse("response.output_text.delta", { type: "response.output_text.delta", content_index: 0, delta: SENTENCE, item_id: itemId, logprobs: [], output_index: 0, sequence_number: 3 }),
    sse("response.output_text.done", { type: "response.output_text.done", content_index: 0, item_id: itemId, logprobs: [], output_index: 0, sequence_number: 4, text: SENTENCE }),
    sse("response.content_part.done", { type: "response.content_part.done", content_index: 0, item_id: itemId, output_index: 0, part, sequence_number: 5 }),
    sse("response.output_item.done", { type: "response.output_item.done", item, output_index: 0, sequence_number: 6 }),
    sse("response.completed", { type: "response.completed", response, sequence_number: 7 }),
  ].join("");
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  req.on("data", () => undefined);
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    res.end(gatewayRefusal());
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-refusal-responses-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir);
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      api: "openai-responses",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
    },
  },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));

console.log("A refused request, on the dialect a workspace speaks\n");

const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
const registry = new ModelRegistry(runtime);
await registry.refresh();
const model = registry.getAll().find((entry) => entry.provider === PROVIDER && entry.id === MODEL);
assert.ok(model, "the stub model did not reach the registry");

const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime: runtime,
  resourceLoader: new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true }),
  tools: [],
  sessionManager: SessionManager.inMemory(cwd),
});

const ended: Array<Record<string, unknown>> = [];
session.subscribe((event: unknown) => {
  const record = event as { type?: string; message?: Record<string, unknown> } | null;
  if (record?.type === "message_end" && record.message?.role === "assistant") ended.push(record.message);
});
await session.prompt("Say ok.");

const last = ended[ended.length - 1];

check("the runtime saw one assistant message", () => assert.equal(ended.length, 1));
check("it carries the gateway's id as responseId", () => assert.equal(last?.responseId, ID, `got ${String(last?.responseId)}`));
check("it finished normally and says what the gateway said", () => {
  assert.equal(last?.stopReason, "stop");
  assert.ok(JSON.stringify(last?.content).includes("limit for this workspace"));
});

server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
