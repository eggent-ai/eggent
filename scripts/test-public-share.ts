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
const systemPrompts: string[] = [];

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
    const payload = JSON.parse(body || "{}") as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    toolSets.push((payload.tools ?? []).map((tool) => tool.function?.name ?? ""));
    const system = (payload.messages ?? []).find((message) => message.role === "system" || message.role === "developer");
    systemPrompts.push(typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? ""));
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
// Facts about the deployment - prices, addresses - that a visitor must never be handed.
process.env.EGGENT_DEPLOYMENT_CONTEXT = "DEPLOYMENT-FACTS-MARKER: the billing page is at https://billing.example.test";

const { runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createProject } = await import("../src/lib/storage/project-store.ts");
const { createPublicShareTools, resolvePublicPath, publicShareRoot } = await import("../src/lib/pi/public-share.ts");

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

console.log("\nA public link: ask and be answered, nothing else\n");

const project = await createProject({
  id: "price-list",
  memoryMode: "isolated",
  name: "Price list",
  description: "What the studio charges",
  instructions: "PROJECT-INSTRUCTIONS-MARKER: answer with prices from prices.md.",
});
const projectDir = path.join(root, "data", "projects", project.id);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-public-outside-"));
fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
fs.writeFileSync(path.join(projectDir, "prices.md"), "Haircut: 30\nColour: 80 hello-marker\n");
fs.mkdirSync(path.join(projectDir, "docs"));
fs.writeFileSync(path.join(projectDir, "docs", "faq.txt"), "Open daily. hello-marker again\n");
fs.writeFileSync(path.join(projectDir, ".env"), "API_KEY=ENV-SECRET-hello-marker\n");
fs.writeFileSync(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { x: { env: { TOKEN: "MCP-SECRET-hello-marker" } } } }));
fs.writeFileSync(path.join(projectDir, "memory.md"), "The owner's private note: hello-marker\n");
fs.writeFileSync(path.join(projectDir, "credentials.json"), "{\"key\":\"CRED-SECRET-hello-marker\"}\n");
fs.mkdirSync(path.join(projectDir, "skills", "pricing"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "skills", "pricing", "SKILL.md"), "internal hello-marker\n");
fs.mkdirSync(path.join(projectDir, "docs", ".hidden"));
fs.writeFileSync(path.join(projectDir, "docs", ".hidden", "x.txt"), "hidden hello-marker\n");
fs.symlinkSync(outside, path.join(projectDir, "link-out"));
fs.symlinkSync(path.join(projectDir, ".env"), path.join(projectDir, "link-env"));
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(projectDir, "docs", "linked-secret.txt"));

await runPiAgentText({
  chatId: "33333333-3333-4333-8333-333333333333",
  userMessage: "how much is a haircut?",
  projectId: project.id,
  enableEggentTools: false,
  publicShare: true,
});
const publicTools = toolSets[2] ?? [];
const publicPrompt = systemPrompts[2] ?? "";
const ownPrompt = systemPrompts[0] ?? "";

await check("a public link is offered kb_search, read, ls and search, and nothing else", () => {
  assert.deepEqual([...publicTools].sort(), ["kb_search", "ls", "read", "search"]);
});
await check("a public link is told to search first and answer only from what it found", () => {
  assert.match(publicPrompt, /call kb_search first/);
  assert.match(publicPrompt, /name the file/);
});
await check("no shell, no writing, no web reaches a public link", () => {
  for (const name of ["bash", "edit", "write", "grep", "find", "Agent", "mcp", "web_search", "fetch_content"]) {
    assert.ok(!publicTools.includes(name), `${name} reached a public link`);
  }
});
await check("the workspace's own chat is told the deployment facts (so the check below means something)", () => {
  assert.ok(ownPrompt.includes("DEPLOYMENT-FACTS-MARKER"), "the marker never reached even the owner's chat");
});
await check("a public link's prompt carries the project's instructions and no deployment facts", () => {
  assert.ok(publicPrompt.includes("PROJECT-INSTRUCTIONS-MARKER"), "the project's instructions are missing");
  assert.ok(!publicPrompt.includes("DEPLOYMENT-FACTS-MARKER"), "the deployment facts reached a public link");
  // The runtime names the working directory, which is the project folder; nothing above it.
  assert.ok(!publicPrompt.includes(agentDir), "the agent's own folder is named to a visitor");
  if (process.env.EGGENT_TEST_SHOW_PROMPT) console.log(publicPrompt);
});

const tools = await createPublicShareTools(projectDir);
const byName = new Map(tools.map((tool) => [tool.name, tool]));
async function call(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`no ${name}`);
  const result = await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>)(
    "call-1", params, undefined, undefined, undefined
  );
  return result.content.map((part) => part.text ?? "").join("\n");
}
async function refused(name: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    const text = await call(name, params);
    return !/SECRET|private note|internal|hidden hello/.test(text) && /not found|No line|empty/i.test(text);
  } catch {
    return true;
  }
}

await check("read opens the project's own files", async () => {
  assert.match(await call("read", { path: "prices.md" }), /Haircut: 30/);
  assert.match(await call("read", { path: "docs/faq.txt" }), /Open daily/);
});
for (const [label, target] of [
  ["a file above the project", "../../agent/auth.json"],
  ["an absolute path outside", path.join(outside, "secret.txt")],
  ["the home folder", "~/.ssh/id_rsa"],
  [".env", ".env"],
  [".mcp.json", ".mcp.json"],
  ["the agent's memory", "memory.md"],
  ["a credentials file", "credentials.json"],
  ["the project's skills", "skills/pricing/SKILL.md"],
  ["a hidden folder", "docs/.hidden/x.txt"],
  ["a link to .env", "link-env"],
  ["a link out of the project", "link-out/secret.txt"],
  ["a file that is a link out", "docs/linked-secret.txt"],
] as const) {
  await check(`read refuses ${label}`, async () => {
    assert.ok(await refused("read", { path: target }), `read answered for ${target}`);
  });
}
await check("ls shows the project's content and none of what is held back", async () => {
  const listing = await call("ls", {});
  assert.match(listing, /prices\.md/);
  assert.match(listing, /docs\//);
  for (const name of [".env", ".mcp.json", "memory.md", "credentials.json", "skills", "link-out", "link-env"]) {
    assert.ok(!listing.split("\n").some((line) => line.replace(/\/$/, "") === name), `ls showed ${name}`);
  }
});
await check("ls refuses a folder outside the project", async () => {
  assert.ok(await refused("ls", { path: outside }));
  assert.ok(await refused("ls", { path: "link-out" }));
});
await check("search finds lines in the project's own files only", async () => {
  const found = await call("search", { query: "hello-marker" });
  assert.match(found, /prices\.md:2:/);
  assert.match(found, /docs\/faq\.txt:1:/);
  for (const leak of ["ENV-SECRET", "MCP-SECRET", "CRED-SECRET", "private note", "internal", "hidden hello", "OUTSIDE-SECRET"]) {
    assert.ok(!found.includes(leak), `search printed ${leak}`);
  }
});
await check("kb_search finds passages in the project's own files only", async () => {
  const found = await call("kb_search", { query: "hello-marker colour" });
  assert.match(found, /prices\.md/);
  for (const leak of ["ENV-SECRET", "MCP-SECRET", "CRED-SECRET", "private note", "internal", "hidden hello", "OUTSIDE-SECRET"]) {
    assert.ok(!found.includes(leak), `kb_search printed ${leak}`);
  }
});
await check("kb_search's index is not something read, ls or search can open", async () => {
  assert.ok(fs.existsSync(path.join(projectDir, ".kb", "chunks.json")), "kb_search built no index");
  assert.ok(await refused("read", { path: ".kb/chunks.json" }));
  assert.ok(await refused("ls", { path: ".kb" }));
  assert.ok(!(await call("ls", {})).includes(".kb"));
});
await check("search refuses to start outside the project", async () => {
  assert.ok(await refused("search", { query: "SECRET", path: outside }));
  assert.ok(await refused("search", { query: "SECRET", path: "../.." }));
});
await check("the boundary is the project folder however the path is spelled", async () => {
  const shareRoot = await publicShareRoot(projectDir);
  assert.equal(await resolvePublicPath(shareRoot, path.join(projectDir, "docs", "..", "..", project.id, ".env")), null);
  assert.ok(await resolvePublicPath(shareRoot, path.join(projectDir, "docs", "..", "prices.md")));
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
