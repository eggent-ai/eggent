/**
 * The same turn, on the Responses dialect, with reasoning switched on.
 *
 * This is the combination `/v1/chat/completions` refuses outright - "Function
 * tools with reasoning_effort are not supported" - which took the whole product
 * down once. Here the stub asserts the shape the runtime actually sends: the
 * Responses body carries `input` rather than `messages`, `tools` flattened
 * rather than wrapped in `function`, and a `reasoning` object beside them.
 *
 * Run with Node 22: npm run test:agent-turn-responses
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "stub";
const MODEL = "stub-model";
const TOOL = "echo_back";
const SPOKEN = "hi";
const ANSWER = "the tool said hi";

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


/**
 * A provider speaking the Responses dialect: asks for the tool once, then
 * answers. It records what the runtime sent so the test can check the shape.
 */
async function startStubProvider(): Promise<{
  url: string;
  calls: () => number;
  toolReplies: () => string[];
  bodies: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  let calls = 0;
  const toolReplies: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
  const server = http.createServer((req, res) => {
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
      calls += 1;
      const payload = JSON.parse(body || "{}") as Record<string, unknown>;
      bodies.push(payload);
      // A tool result comes back as its own input item, not as a `tool` message.
      const input = Array.isArray(payload.input) ? payload.input as Array<Record<string, unknown>> : [];
      const results = input.filter((item) => item.type === "function_call_output");
      for (const item of results) {
        if (typeof item.output === "string") toolReplies.push(item.output);
      }
      const toolHasReported = results.length > 0;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const response = { id: "resp-1", object: "response", status: "in_progress", model: MODEL, output: [] };
      res.write(sse({ type: "response.created", response }));
      if (toolHasReported) {
        const item = { id: "msg-1", type: "message", status: "in_progress", role: "assistant", content: [] };
        res.write(sse({ type: "response.output_item.added", output_index: 0, item }));
        res.write(sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg-1", delta: ANSWER }));
        res.write(sse({ type: "response.output_item.done", output_index: 0,
          item: { ...item, status: "completed", content: [{ type: "output_text", text: ANSWER }] } }));
        res.write(sse({ type: "response.completed", response: { ...response, status: "completed",
          output: [{ ...item, status: "completed", content: [{ type: "output_text", text: ANSWER }] }],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } }));
      } else {
        const call = { id: "fc-1", type: "function_call", status: "in_progress",
                       name: TOOL, call_id: "stub-call-1", arguments: "" };
        res.write(sse({ type: "response.output_item.added", output_index: 0, item: call }));
        const args = JSON.stringify({ text: SPOKEN });
        res.write(sse({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-1", delta: args }));
        res.write(sse({ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc-1", arguments: args }));
        res.write(sse({ type: "response.output_item.done", output_index: 0,
          item: { ...call, status: "completed", arguments: args } }));
        res.write(sse({ type: "response.completed", response: { ...response, status: "completed",
          output: [{ ...call, status: "completed", arguments: args }],
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } }));
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls: () => calls,
    toolReplies: () => [...toolReplies],
    bodies: () => [...bodies],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

console.log("A turn through the agent runtime, on the Responses dialect\n");

const stub = await startStubProvider();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-agent-turn-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir);
fs.mkdirSync(cwd);
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        [PROVIDER]: {
          name: "Stub",
          baseUrl: stub.url,
          api: "openai-responses",
          // `reasoning: true` is exactly what the catalog writes into models.json, and
          // what makes the runtime send an effort at all.
          models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024, reasoning: true }],
        },
      },
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(agentDir, "auth.json"),
  JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }, null, 2)
);

const echoed: string[] = [];
const echoBack = defineTool({
  name: TOOL,
  label: "Echo Back",
  description: "Repeat the given text back to the model.",
  parameters: Type.Object({ text: Type.String({ description: "What to repeat." }) }),
  execute: async (_toolCallId: string, params: { text: string }) => {
    echoed.push(params.text);
    return { content: [{ type: "text" as const, text: `echoed ${params.text}` }], details: {} };
  },
});

const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
const registry = new ModelRegistry(runtime);
await registry.refresh();
const model = registry.getAll().find((entry) => entry.provider === PROVIDER && entry.id === MODEL);

check("a provider written into models.json reaches the registry", () => assert.ok(model));

let assistantText = "";
const stopReasons: string[] = [];
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime: runtime,
  resourceLoader: new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true }),
  tools: [TOOL],
  customTools: [echoBack],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(cwd),
});

const unsubscribe = session.subscribe((event: unknown) => {
  const record = event as Record<string, unknown> | null;
  if (!record) return;
  if (record.type === "message_update") {
    // Deltas only: the cumulative field this used to carry was removed in 0.84.
    const delta = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (delta?.type === "text_delta" && typeof delta.delta === "string") assistantText += delta.delta;
  }
  if (record.type === "message_end") {
    const message = record.message as { role?: string; stopReason?: string } | undefined;
    if (message?.role === "assistant" && typeof message.stopReason === "string") stopReasons.push(message.stopReason);
  }
});

await session.prompt("Use the tool, then tell me what it said.");
unsubscribe?.();

check("the tool ran, with arguments the runtime had validated", () => assert.deepEqual(echoed, [SPOKEN]));
check("the tool result went back to the provider", () => assert.equal(stub.calls(), 2));
check("and it carried what the tool returned", () => assert.deepEqual(stub.toolReplies(), [`echoed ${SPOKEN}`]));
check("the answer arrived as text deltas", () => assert.ok(assistantText.includes(ANSWER), `got: ${assistantText || "(nothing)"}`));
check("the runtime spoke the Responses dialect, not chat completions", () => {
  const first = stub.bodies()[0] ?? {};
  assert.ok(Array.isArray(first.input), "тело должно нести input, а не messages");
  assert.equal(first.messages, undefined);
});
check("tools and reasoning travelled together", () => {
  // The pair /v1/chat/completions refuses. If this ever stops holding, the
  // product goes back to answering every message with that refusal.
  const first = stub.bodies()[0] as Record<string, unknown>;
  const tools = first.tools as Array<Record<string, unknown>> | undefined;
  assert.ok(tools && tools.length > 0, "инструменты не доехали");
  assert.equal(tools![0].name, TOOL, "инструмент должен лежать плоско, без обёртки function");
  assert.ok(first.reasoning, "размышление не доехало");
});
check("no turn ended in a provider error", () => assert.ok(!stopReasons.includes("error"), stopReasons.join(", ")));

await stub.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
