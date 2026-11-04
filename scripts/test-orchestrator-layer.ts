/**
 * A project sits on the orchestrator rather than replacing it.
 *
 * Drives the real session builder against a stub provider and reads the system
 * prompt the provider was sent: a project's chat carries the orchestrator's
 * instructions beneath its own, its skills marked, and the names of its MCP
 * servers; the orchestrator, a visit, a public chat and a project set to keep
 * to itself carry none of it.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:orchestrator-layer
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
const prompts: string[] = [];

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
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
    // Everything the model is told before the first thing the person said: the
    // runtime's own preamble and the context files, which is where Eggent puts
    // its workspace block.
    const system = (payload.messages ?? []).filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
    prompts.push(system);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "ok" }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-orchestrator-layer-"));
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
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL })
);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.EGGENT_LEARNING;

const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "skills"), { recursive: true });

const projectStore = await import("../src/lib/storage/project-store.ts");
const { createEggentPiSession, ORCHESTRATOR_LAYER_MAX_CHARS } = await import("../src/lib/pi/session.ts");

function skill(dir: string, name: string, description: string): void {
  fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\nSteps for ${name}.\n`
  );
}
function mcp(dir: string, ids: string[]): void {
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: Object.fromEntries(ids.map((id) => [id, { url: `https://${id}.example.test/mcp` }])) })
  );
}

const ORCH = "The person is Anna, she runs a bakery. Recipes live in the shop project.";
fs.writeFileSync(path.join(projectsDir, "context.md"), ORCH);
skill(projectsDir, "recipe-card", "Makes a recipe card from the recipes sheet.");
skill(projectsDir, "shop-catalog", "The orchestrator's idea of a catalog.");
mcp(projectsDir, ["bybit", "notion"]);

await projectStore.createProject({ id: "shop", name: "Shop", description: "The shop project", instructions: "Shop rules: answer in English.", memoryMode: "isolated" } as never);
const shopDir = path.join(projectsDir, "shop");
skill(shopDir, "shop-catalog", "How the shop lists its products.");
mcp(shopDir, ["notion"]);

async function promptSeenBy(options: Record<string, unknown>): Promise<string> {
  prompts.length = 0;
  const session = await createEggentPiSession({ agentDir, ...options } as never);
  try {
    await session.prompt("hello");
  } finally {
    session.dispose();
  }
  assert.equal(prompts.length >= 1, true, "the provider was reached");
  return prompts[0];
}

console.log("A project sits on the orchestrator\n");

await check("a project's chat gets the orchestrator's instructions after its own, and is told which come first", async () => {
  const system = await promptSeenBy({ projectId: "shop" });
  assert.ok(system.includes(ORCH), "the orchestrator's text is there");
  assert.ok(system.indexOf("Shop rules: answer in English.") < system.indexOf(ORCH), "the project's own instructions first");
  assert.match(system, /inside the project "Shop"/);
  assert.match(system, /follow the project/);
});

await check("the orchestrator's skills are listed and marked, and the project's own wins a name", async () => {
  const system = await promptSeenBy({ projectId: "shop" });
  assert.match(system, /\| recipe-card \|[^\n]*\[orchestrator\]/);
  const rows = system.split("\n").filter((line) => line.startsWith("| shop-catalog |"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /How the shop lists its products/);
});

await check("the orchestrator's MCP servers the project lacks are named, with the way to reach them", async () => {
  const system = await promptSeenBy({ projectId: "shop" });
  assert.match(system, /MCP servers connected in the orchestrator but not in this project: bybit\./);
  assert.match(system, /switch_project with project_id 'none'/);
});

await check("the orchestrator's memory file is named", async () => {
  const system = await promptSeenBy({ projectId: "shop" });
  assert.ok(system.includes(path.join(projectsDir, "memory.md")));
});

await check("the orchestrator itself carries its instructions once", async () => {
  const system = await promptSeenBy({});
  assert.equal(system.split(ORCH).length - 1, 1);
  assert.doesNotMatch(system, /beneath this project/);
  assert.doesNotMatch(system, /\[orchestrator\]/);
});

await check("a visit answers from the project's own desk", async () => {
  const system = await promptSeenBy({ projectId: "shop", visit: { parentChatId: "parent", parentTitle: "Parent" } });
  assert.ok(!system.includes(ORCH));
  assert.doesNotMatch(system, /recipe-card/);
  assert.doesNotMatch(system, /bybit/);
});

await check("a public chat sees none of it", async () => {
  const system = await promptSeenBy({ projectId: "shop", publicShare: true });
  assert.ok(!system.includes(ORCH));
  assert.doesNotMatch(system, /recipe-card/);
});

await check("a long orchestrator file is cut and points at the whole file", async () => {
  const long = `${ORCH}\n${"x".repeat(ORCHESTRATOR_LAYER_MAX_CHARS)}\nTAIL-MARKER`;
  fs.writeFileSync(path.join(projectsDir, "context.md"), long);
  try {
    const system = await promptSeenBy({ projectId: "shop" });
    assert.ok(system.includes(ORCH));
    assert.ok(!system.includes("TAIL-MARKER"));
    assert.match(system, /\[\.\.\.cut here; the whole file is \S*context\.md\]/, system.slice(system.indexOf("cut here") - 20, system.indexOf("cut here") + 200));
  } finally {
    fs.writeFileSync(path.join(projectsDir, "context.md"), ORCH);
  }
});

await check("a project set to keep to itself sees nothing of the orchestrator", async () => {
  await projectStore.updateProject("shop", { inheritOrchestrator: false });
  try {
    const system = await promptSeenBy({ projectId: "shop" });
    assert.ok(!system.includes(ORCH));
    assert.doesNotMatch(system, /recipe-card/);
    assert.doesNotMatch(system, /bybit/);
    assert.match(system, /\| shop-catalog \|/);
  } finally {
    await projectStore.updateProject("shop", { inheritOrchestrator: true });
  }
});

console.log(`\n${ran - failed}/${ran} passed`);
provider.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
