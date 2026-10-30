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

console.log("\nA guest's turn: a card to ask with and answers to leave, nothing more\n");

const { createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { recordPublicAnswer, parseCsv } = await import("../src/lib/pi/public-share-answers.ts");
const { guestVisibleStream, guestAnswer } = await import("../src/lib/external/guest-turn.ts");
const { resolveGuestSessionChat } = await import("../src/lib/external/handle-external-message.ts");
const { registerActiveRun, clearActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { createPendingInteraction } = await import("../src/lib/pi/pending-interactions.ts");

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
}
const VISITOR = { name: "Anna", email: "anna@example.test", confirmed: false, conversation: "conv0001" };
await drain(createPiChatUIMessageStream({
  chatId: "44444444-4444-4444-8444-444444444444",
  userMessage: "hello",
  projectId: project.id,
  publicShare: true,
  enableEggentTools: false,
}));
await drain(createPiChatUIMessageStream({
  chatId: "55555555-5555-4555-8555-555555555555",
  userMessage: "hello",
  projectId: project.id,
  publicShare: true,
  enableEggentTools: false,
  toolRuntimeData: { publicAnswers: { file: "link-order-form", visitor: VISITOR } },
}));
const guestTools = toolSets[3] ?? [];
const guestPrompt = systemPrompts[3] ?? "";
const answeringTools = toolSets[4] ?? [];
const answeringPrompt = systemPrompts[4] ?? "";

await check("a guest's turn somebody watches adds the question card, and nothing else of the workspace", () => {
  assert.deepEqual([...guestTools].sort(), ["eggent_ask_user", "kb_search", "ls", "read", "search"]);
  assert.match(guestPrompt, /eggent_ask_user/);
  assert.doesNotMatch(guestPrompt, /eggent_record_answer/);
});
await check("the answers tool is there only where the host said where answers go", () => {
  assert.deepEqual([...answeringTools].sort(), ["eggent_ask_user", "eggent_record_answer", "kb_search", "ls", "read", "search"]);
  assert.match(answeringPrompt, /eggent_record_answer/);
  // Who is writing is the host's to say and is never put in front of the model.
  assert.ok(!answeringPrompt.includes(VISITOR.email), "the visitor's email reached the prompt");
});
await check("a guest's turn is still not handed the deployment facts", () => {
  assert.ok(!answeringPrompt.includes("DEPLOYMENT-FACTS-MARKER"));
  assert.ok(answeringPrompt.includes("PROJECT-INSTRUCTIONS-MARKER"));
});

const target = { file: "link-order-form", visitor: VISITOR };
await check("an answer becomes a row stamped with who wrote it, whatever the model claims", async () => {
  const saved = await recordPublicAnswer(projectDir, target, { colour: "red", email: "someone-else@example.test", name: "Mallory" }, new Date("2026-10-30T10:00:00Z"));
  assert.ok(saved.ok);
  const rows = parseCsv(fs.readFileSync(path.join(projectDir, "responses", "link-order-form.csv"), "utf-8").replace(/^﻿/, ""));
  assert.deepEqual(rows[0], ["time", "name", "email", "email confirmed", "conversation", "colour"]);
  assert.deepEqual(rows[1], ["2026-10-30T10:00:00.000Z", "Anna", "anna@example.test", "no", "conv0001", "red"]);
});
await check("a new question adds a column and keeps the earlier rows in line", async () => {
  await recordPublicAnswer(projectDir, target, { colour: "blue", size: "M" });
  const rows = parseCsv(fs.readFileSync(path.join(projectDir, "responses", "link-order-form.csv"), "utf-8").replace(/^﻿/, ""));
  assert.equal(rows[0].at(-1), "size");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.length === rows[0].length || row.length === rows[0].length - 1));
  assert.equal(rows[2][rows[0].indexOf("size")], "M");
});
await check("a formula in an answer is kept as text for a spreadsheet", async () => {
  await recordPublicAnswer(projectDir, target, { colour: "=HYPERLINK(\"http://evil.example.test\")" });
  const text = fs.readFileSync(path.join(projectDir, "responses", "link-order-form.csv"), "utf-8");
  assert.ok(!/,=HYPERLINK/.test(text) && !/,"=HYPERLINK/.test(text), "a formula reached the file as a formula");
  assert.match(text, /'=HYPERLINK/);
});
await check("answers cannot be read back: responses/ is closed to read, ls and search", async () => {
  assert.ok(await refused("read", { path: "responses/link-order-form.csv" }));
  assert.ok(await refused("ls", { path: "responses" }));
  assert.ok(!(await call("ls", {})).split("\n").some((line) => line.replace(/\/$/, "") === "responses"));
  assert.match(await call("search", { query: "anna@example.test" }), /No line/);
});
await check("a responses folder that is a link out of the project is not written through", async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-public-other-"));
  const linkedProject = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-public-linked-"));
  fs.symlinkSync(other, path.join(linkedProject, "responses"));
  const saved = await recordPublicAnswer(linkedProject, target, { colour: "green" });
  assert.equal(saved.ok, false);
  assert.deepEqual(fs.readdirSync(other), []);
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(linkedProject, { recursive: true, force: true });
});
await check("a file name from the host cannot climb out of responses/", async () => {
  const before = fs.readdirSync(path.join(projectDir, "responses")).length;
  const saved = await recordPublicAnswer(projectDir, { file: "../../escape", visitor: VISITOR }, { colour: "x" });
  assert.ok(saved.ok && saved.file.startsWith("responses/") && !saved.file.includes(".."), JSON.stringify(saved));
  assert.equal(fs.readdirSync(path.join(projectDir, "responses")).length, before + 1);
  for (const place of [projectDir, path.join(projectDir, ".."), path.join(root, "data")]) {
    assert.ok(!fs.readdirSync(place).some((name) => name.includes("escape")), `a file escaped into ${place}`);
  }
});
await check("a guest is not shown what the turn cost or the owner's file cards", async () => {
  const frames = [
    { type: "text-delta", id: "t", delta: "hi" },
    { type: "data-piStats", data: { model: { id: "secret-model" }, session: { cost: 1 } } },
    { type: "data-eggentFiles", data: [] },
    { type: "data-piInteraction", data: { id: "q" } },
  ].map((part) => `data: ${JSON.stringify(part)}\n\n`).join("");
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(frames)); controller.close(); } });
  const text = await new Response(guestVisibleStream(source)).text();
  assert.match(text, /text-delta/);
  assert.match(text, /data-piInteraction/);
  assert.doesNotMatch(text, /piStats|secret-model|eggentFiles/);
});
await check("a guest answers only a card the turn in their own conversation put up, and only words or a choice", async () => {
  const mine = "share:tokenA:visitor1:conv0001";
  const theirs = "share:tokenA:visitor2:conv0002";
  const { chatId } = await resolveGuestSessionChat(mine, project.id);
  const { chatId: otherChat } = await resolveGuestSessionChat(theirs, project.id);
  const fake = { abort: async () => undefined, steer: async () => undefined, isStreaming: true };
  registerActiveRun(chatId, { session: fake, runId: "run-mine", surface: "external" });
  registerActiveRun(otherChat, { session: fake, runId: "run-theirs", surface: "external" });
  const ask = (runId: string, kind: "text" | "secret") => {
    let id = "";
    const answer = createPendingInteraction({ runId, kind, title: "Q?", onUpdate: (interaction) => { id = interaction.id; } });
    return { answer, id: () => id };
  };
  const theirsCard = ask("run-theirs", "text");
  const secretCard = ask("run-mine", "secret");
  const myCard = ask("run-mine", "text");
  assert.equal(await guestAnswer(mine, { interactionId: theirsCard.id(), value: "stolen" }), false);
  assert.equal(await guestAnswer(mine, { interactionId: secretCard.id(), value: "hunter2" }), false);
  assert.equal(await guestAnswer("share:tokenA:nobody:conv9999", { interactionId: myCard.id(), value: "x" }), false);
  assert.equal(await guestAnswer(mine, { interactionId: myCard.id(), value: "Blue" }), true);
  assert.equal(await myCard.answer, "Blue");
  clearActiveRun(chatId, "run-mine");
  clearActiveRun(otherChat, "run-theirs");
});
await check("a share's first message is written once, at the start of a new conversation, and told to the model as its own", async () => {
  const { guestTurnResponse, guestChat } = await import("../src/lib/external/guest-turn.ts");
  const fresh = "share:tokenA:visitor9:conv0009";
  const before = systemPrompts.length;
  await (await guestTurnResponse({ sessionId: fresh, projectId: project.id, message: "yes", opening: "Hi! Shall we start the survey?" })).text();
  const first = await guestChat(fresh);
  assert.equal(first?.messages[0].role, "assistant");
  assert.equal(first?.messages[0].content, "Hi! Shall we start the survey?");
  assert.equal(first?.messages[1].role, "user");
  const prompt = systemPrompts[before] ?? "";
  assert.match(prompt, /You opened this conversation/);
  assert.match(prompt, /Shall we start the survey\?/);
  // The next message neither adds it again nor changes it, whatever the share says now.
  await (await guestTurnResponse({ sessionId: fresh, projectId: project.id, message: "go on", opening: "A new greeting" })).text();
  const again = await guestChat(fresh);
  assert.equal(again?.messages.filter((message) => message.opening).length, 1);
  assert.match(systemPrompts.at(-1) ?? "", /Shall we start the survey\?/);
  assert.doesNotMatch(systemPrompts.at(-1) ?? "", /A new greeting/);
});
await check("a conversation begun without one gets none later", async () => {
  const { guestTurnResponse, guestChat } = await import("../src/lib/external/guest-turn.ts");
  const plain = "share:tokenA:visitor9:conv0010";
  await (await guestTurnResponse({ sessionId: plain, projectId: project.id, message: "hello" })).text();
  await (await guestTurnResponse({ sessionId: plain, projectId: project.id, message: "again", opening: "Late greeting" })).text();
  const chat = await guestChat(plain);
  assert.equal(chat?.messages[0].role, "user");
  assert.ok(!chat?.messages.some((message) => message.opening));
  assert.doesNotMatch(systemPrompts.at(-1) ?? "", /Late greeting|You opened this conversation/);
});
await check("the guest route wants the external token and a guest's session id", async () => {
  const { NextRequest } = await import("next/server");
  process.env.EXTERNAL_API_TOKEN = "guest-route-token";
  const route = await import("../src/app/api/external/guest/route.ts");
  const req = (headers: Record<string, string>, body: unknown) =>
    new NextRequest("http://localhost/api/external/guest", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await route.POST(req({}, { action: "stop", sessionId: "share:a:b" }))).status, 401);
  assert.equal((await route.POST(req({ authorization: "Bearer wrong-token-xx" }, { action: "stop", sessionId: "share:a:b" }))).status, 401);
  // The workspace's own chats and its Telegram sessions are not a guest's to stop or read.
  assert.equal((await route.POST(req({ authorization: "Bearer guest-route-token" }, { action: "stop", sessionId: "telegram:12345" }))).status, 400);
  assert.equal((await route.POST(req({ authorization: "Bearer guest-route-token" }, { action: "stop", sessionId: "share:a:b" }))).status, 200);
  delete process.env.EXTERNAL_API_TOKEN;
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
