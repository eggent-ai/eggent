/**
 * A public share must not be handed the workspace's own tools.
 *
 * `handleExternalMessage` asks for `enableEggentTools: false` when a shared
 * link is the one writing, and the flag was accepted by `runPiAgentText` and
 * even read by the learning gate - but never reached the session, so a visitor
 * to the link talked to an agent with `switch_project`, the schedule manager,
 * the Telegram tools and the rest. This drives the real runner against a stub
 * provider and reads the tool list the provider is sent.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:public-share
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
const toolSets: string[][] = [];

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
    const payload = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
    toolSets.push((payload.tools ?? []).map((tool) => tool.function?.name ?? ""));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "ok" }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-public-share-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Stub",
        baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        api: "openai-completions",
        models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
      },
    },
  })
);
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";

const { runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");

/** Tools that only exist because Eggent put them there. */
const WORKSPACE_TOOLS = ["switch_project", "list_projects", "create_project", "eggent_ask_user", "eggent_manage_schedules", "telegram_send_message"];

console.log("A shared chat and the workspace's tools\n");

await runPiAgentText({
  chatId: "11111111-1111-4111-8111-111111111111",
  userMessage: "hello",
});
await runPiAgentText({
  chatId: "22222222-2222-4222-8222-222222222222",
  userMessage: "hello",
  enableEggentTools: false,
});

const own = toolSets[0] ?? [];
const shared = toolSets[1] ?? [];

await check("the workspace's own chat is offered the workspace tools", () => {
  for (const name of WORKSPACE_TOOLS) assert.ok(own.includes(name), `${name} missing from ${own.join(", ")}`);
});
await check("a shared chat is offered none of them", () => {
  for (const name of WORKSPACE_TOOLS) assert.ok(!shared.includes(name), `${name} reached a public share`);
  assert.ok(!shared.some((name) => name.startsWith("eggent_")), `an eggent_ tool reached a public share: ${shared.join(", ")}`);
});
await check("a shared chat still has the runtime's own tools to work with", () => {
  assert.ok(shared.length > 0, "the shared chat was left with no tools at all");
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
