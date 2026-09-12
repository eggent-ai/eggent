/**
 * One real turn through the agent runtime, against a stub provider.
 *
 * Every other test here drives our own code around the SDK. This is the only
 * one that runs the SDK itself - a session, a custom tool, and the stream of
 * events a turn is assembled from - so that an SDK upgrade has something to
 * fail against other than somebody's chat. It needs no network and no
 * credential: the provider is a local server answering in the
 * OpenAI-compatible dialect, and the key is a fixture.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-agent-turn.ts
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

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/**
 * A provider that asks for the tool once, then answers.
 *
 * Two turns of the loop is what makes this worth running: the request carrying
 * the tool result is the one that proves the arguments were validated, the tool
 * ran, and its output went back out.
 */
async function startStubProvider(): Promise<{
  url: string;
  calls: () => number;
  toolReplies: () => string[];
  close: () => Promise<void>;
}> {
  let calls = 0;
  const toolReplies: string[] = [];
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
      const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
      const toolMessages = (payload.messages ?? []).filter((message) => message.role === "tool");
      for (const message of toolMessages) {
        if (typeof message.content === "string") toolReplies.push(message.content);
      }
      const toolHasReported = toolMessages.length > 0;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(chunk({ role: "assistant" }));
      if (toolHasReported) {
        res.write(chunk({ content: ANSWER }));
        res.write(chunk({}, "stop"));
      } else {
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "stub-call-1",
                type: "function",
                function: { name: TOOL, arguments: JSON.stringify({ text: SPOKEN }) },
              },
            ],
          })
        );
        res.write(chunk({}, "tool_calls"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls: () => calls,
    toolReplies: () => [...toolReplies],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

console.log("A turn through the agent runtime\n");

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
          api: "openai-completions",
          models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
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
check("no turn ended in a provider error", () => assert.ok(!stopReasons.includes("error"), stopReasons.join(", ")));

await stub.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
