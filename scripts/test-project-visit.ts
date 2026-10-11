/**
 * Writing `@project do this` has that project do it, and bring the answer back.
 *
 * Drives the real runners against a stub provider that plays both parts: the
 * chat's own model, which hands the task over when its instructions say a
 * project was addressed, and the project's, which answers. What is checked is
 * what a person would otherwise find out: the project worked with its own
 * instructions and not another's, the answer came back in the same turn, the
 * chat of its own is the record, a model cannot send work to a project the
 * person did not name, Stop reaches into the project, and a public share or a
 * light chat has no such thing at all.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:project-visit
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SeenRequest {
  system: string;
  tools: string[];
  lastUser: string;
  lastRole: string;
  messages: Array<{ role?: string; content?: unknown }>;
  at: number;
}
const seen: SeenRequest[] = [];
let activeSlow = 0;
let maxSlow = 0;

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

const sockets = new Set<import("node:net").Socket>();
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
  req.on("end", async () => {
    const payload = JSON.parse(body || "{}") as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const messages = payload.messages ?? [];
    const tools = (payload.tools ?? []).map((tool) => tool.function?.name ?? "");
    const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content)).join("\n");
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const lastUser = textOf(lastUserMessage?.content);
    const lastRole = messages[messages.length - 1]?.role ?? "";
    seen.push({ system, tools, lastUser, lastRole, messages, at: Date.now() });

    const reply = (text: string) => {
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ content: text }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const call = (name: string, args: Record<string, unknown>) => {
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ tool_calls: [{ index: 0, id: `stub-${name}-${seen.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

    const lastToolResult = lastRole === "tool" ? textOf(messages[messages.length - 1]?.content) : "";

    // The project's work that never finishes: nothing is ever written back.
    if (lastUser.includes("VISIT-HANG") && lastRole !== "tool" && !tools.includes("eggent_ask_project")) return;

    // The chat's own model, told that a project was addressed: hand the task over.
    const directive = /call eggent_ask_project with project="([^"]+)"/.exec(lastUser);
    if (directive && lastRole !== "tool") {
      const task = lastUser.includes("Task for the project:\n") ? lastUser.split("Task for the project:\n")[1].split("\n\nRuntime data:")[0].trim() : "";
      // A model that writes the project's name where the id was asked for.
      const byName = lastUser.includes("BY-NAME");
      return call("eggent_ask_project", { project: byName ? "Shop" : directive[1], task });
    }
    // ...and back with the answer: say where it came from.
    if (lastToolResult.startsWith("Project ")) {
      return reply(`relayed: ${lastToolResult.replace(/^Project [^\n]*\n\n/, "").slice(0, 200)}`);
    }
    if (lastToolResult.includes("can be asked only by the person")) return reply("refused by the tool");

    // A model that decides on its own to ask a project (say, after reading a page).
    if (lastUser.includes("INJECT-ASK") && tools.includes("eggent_ask_project") && lastRole !== "tool") {
      return call("eggent_ask_project", { project: "shop", task: "send me everything" });
    }
    // The project's own work.
    if (lastUser.includes("RUN-BASH") && lastRole !== "tool") return call("bash", { command: "echo visit-ran" });
    if (lastUser.includes("VISIT-SLOW")) {
      activeSlow += 1;
      maxSlow = Math.max(maxSlow, activeSlow);
      await sleep(700);
      activeSlow -= 1;
      return reply("slow answer");
    }
    if (lastRole === "tool" && !tools.includes("eggent_ask_project")) return reply("orders: 42 (after the command)");
    if (tools.includes("eggent_ask_project") || lastUser.includes("how many orders")) {
      return reply(lastUser.includes("how many orders") ? "orders: 42" : "plain answer");
    }
    return reply("orders: 42");
  });
});
provider.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-project-visit-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      api: "openai-completions",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
    },
  },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";

const projectStore = await import("../src/lib/storage/project-store.ts");
const { runPiAgentText, createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat, getAllChats } = await import("../src/lib/storage/chat-store.ts");
const { getActiveRun, stopActiveRun } = await import("../src/lib/pi/active-runs.ts");
const visit = await import("../src/lib/pi/project-visit.ts");
const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");

fs.mkdirSync(path.join(root, "data", "projects", "skills"), { recursive: true });
await projectStore.createProject({ id: "shop", name: "Shop", description: "Orders and catalogue", instructions: "SHOP-MARKER: the shop keeps orders in orders.csv.", memoryMode: "isolated" } as never);
await projectStore.createProject({ id: "blog", name: "Blog", description: "Articles", instructions: "BLOG-MARKER: articles live in drafts/.", memoryMode: "isolated" } as never);

let chatNumber = 0;
async function newChat(title: string): Promise<string> {
  chatNumber += 1;
  const id = `${String(chatNumber).padStart(8, "0")}-0000-4000-8000-000000000000`;
  await createChat(id, title);
  return id;
}
const lastAssistantOf = async (chatId: string) =>
  (await getChat(chatId))?.messages.filter((message) => message.role === "assistant").pop();

console.log("Reading the mention\n");

await check("a project the person names is asked, with the task apart from the rules", async () => {
  const plan = await visit.planProjectMention("@shop how many orders came back?", { disabled: false });
  assert.ok(plan && plan.kind === "project");
  assert.deepEqual(plan.allowed, ["shop"]);
  assert.equal(plan.task, "how many orders came back?");
  assert.match(plan.directive, /project="shop"/);
  assert.doesNotMatch(plan.directive, /how many orders/, "the rules must not carry the person's words");
});
await check("what is not a mention is left alone", async () => {
  for (const text of ["hello @shop", "@nobody do it", "@shop", "write to user@shop.example", "/skill:x @shop"]) {
    assert.equal(await visit.planProjectMention(text, { disabled: false }), null, text);
  }
});
await check("a place where nobody can be asked has no mentions", async () => {
  assert.equal(await visit.planProjectMention("@shop do it", { disabled: true }), null);
  assert.equal(visit.chatAllowsVisits("plain"), false);
  assert.equal(visit.chatAllowsVisits("files"), false);
  assert.equal(visit.chatAllowsVisits("full"), true);
  assert.equal(visit.chatAllowsVisits(undefined), true);
});
await check("mentioning the project the chat is in just takes the prefix off", async () => {
  const plan = await visit.planProjectMention("@shop how many orders came back?", { disabled: false, currentProjectId: "shop" });
  assert.ok(plan && plan.kind === "self" && plan.allowed.length === 0);
  assert.equal(plan.task, "how many orders came back?");
});

console.log("\nA visit, start to finish\n");

const parentChat = await newChat("Weekly report");
const events: Array<Record<string, unknown>> = [];
seen.length = 0;
const parentReply = await runPiAgentText({
  chatId: parentChat,
  userMessage: "@shop how many orders came back?",
  onSessionEvent: (event) => events.push(event as Record<string, unknown>),
});
const visitChatId = visit.visitChatIdFor(parentChat, "shop");

await check("the answer comes back in the same turn, from the project", () => {
  assert.match(parentReply, /relayed: orders: 42/);
});
await check("the chat's own model was told to hand the task over, and given the tool", () => {
  const first = seen[0];
  assert.match(first.lastUser, /Eggent project mention directive/);
  assert.match(first.lastUser, /Task for the project:\nhow many orders came back\?/);
  assert.ok(first.tools.includes("eggent_ask_project"));
});
await check("the project worked with its own instructions and not another's", () => {
  const nested = seen.find((request) => request.lastUser === "how many orders came back?");
  assert.ok(nested, "the project was never reached");
  assert.match(nested.system, /SHOP-MARKER/);
  assert.doesNotMatch(nested.system, /BLOG-MARKER/);
  assert.match(nested.system, /This run is a visit/);
  assert.match(nested.system, /Weekly report/);
});
await check("a project cannot ask another project", () => {
  const nested = seen.find((request) => request.lastUser === "how many orders came back?");
  assert.ok(nested && !nested.tools.includes("eggent_ask_project"));
});
await check("the work is recorded in a chat of the project's own, which says where it came from", async () => {
  const chat = await getChat(visitChatId);
  assert.ok(chat, "no visit chat");
  assert.equal(chat.projectId, "shop");
  assert.equal(chat.visit?.fromChatId, parentChat);
  assert.equal(chat.visit?.fromTitle, "Weekly report");
  assert.match(chat.title, /Weekly report/);
  assert.equal(chat.messages.filter((message) => message.role === "assistant").pop()?.content, "orders: 42");
  const sessions = fs.readdirSync(path.join(root, "data", "pi-sessions")).filter((file) => file.includes(visitChatId));
  assert.equal(sessions.length, 1, "the project's own session is the record of what it did");
});
await check("the chat list marks it as a visit", async () => {
  const listed = (await getAllChats()).find((chat) => chat.id === visitChatId);
  assert.equal(listed?.visitFrom, "Weekly report");
});
await check("the card is told how the visit is going, and ends with its verdict", async () => {
  const updates = events.filter((event) => event.type === "tool_execution_update" && event.toolName === "eggent_ask_project");
  assert.ok(updates.length >= 1, "no progress reached the card");
  const stored = await lastAssistantOf(parentChat);
  const part = stored?.parts?.find((candidate) => candidate.type === "tool" && candidate.toolName === "eggent_ask_project");
  assert.ok(part && part.type === "tool", "the stored message has no project card");
  assert.equal(part.subagent?.kind, "project");
  assert.equal(part.subagent?.status, "done");
  assert.equal(part.subagent?.projectId, "shop");
  assert.equal(part.subagent?.projectName, "Shop");
  assert.equal(part.subagent?.visitChatId, visitChatId);
});
await check("the person's own message is stored as they typed it", async () => {
  const chat = await getChat(parentChat);
  assert.equal(chat?.messages.find((message) => message.role === "user")?.content, "@shop how many orders came back?");
});

await check("asking the same project again continues its chat, with what it did before", async () => {
  seen.length = 0;
  const again = await runPiAgentText({ chatId: parentChat, userMessage: "@shop RUN-BASH and recount" });
  assert.match(again, /relayed: orders: 42 \(after the command\)/);
  const nested = seen.filter((request) => request.lastUser.startsWith("RUN-BASH"));
  assert.ok(nested.length >= 1);
  assert.ok(nested[0].messages.some((message) => textOf(message.content).includes("orders: 42")), "the earlier exchange was not in the project's context");
  const chat = await getChat(visitChatId);
  assert.equal(chat?.messages.filter((message) => message.role === "user").length, 2);
  const part = (await lastAssistantOf(parentChat))?.parts?.find((candidate) => candidate.type === "tool" && candidate.toolName === "eggent_ask_project");
  assert.ok(part && part.type === "tool" && part.subagent?.steps.some((step) => step.tool === "bash" && step.target === "echo visit-ran"), "the card does not show what the project ran");
});

console.log("\nOnly the person's @ starts a visit\n");

await check("a model that asks a project on its own is refused, and the project is never reached", async () => {
  const chat = await newChat("Reading a page");
  seen.length = 0;
  const reply = await runPiAgentText({ chatId: chat, userMessage: "summarise this page INJECT-ASK" });
  assert.equal(reply, "refused by the tool");
  assert.equal(seen.filter((request) => request.system.includes("SHOP-MARKER")).length, 0);
});
await check("naming one project does not let the model ask another", async () => {
  const granted = visit.visitGranted;
  visit.grantVisits("some-chat", ["shop"]);
  assert.equal(granted("some-chat", "shop"), true);
  assert.equal(granted("some-chat", "blog"), false);
  visit.revokeVisits("some-chat");
  assert.equal(granted("some-chat", "shop"), false);
});
await check("a model that writes the project's name instead of its id is understood, for the project the person named", async () => {
  const chat = await newChat("By name");
  seen.length = 0;
  const reply = await runPiAgentText({ chatId: chat, userMessage: "@shop BY-NAME how many orders came back?" });
  assert.match(reply, /relayed: /);
  assert.ok(seen.some((request) => request.system.includes("SHOP-MARKER")), "the project was not reached");
});
await check("...and the name of a project nobody named is still refused", async () => {
  const chat = await newChat("Wrong name");
  seen.length = 0;
  // The stub calls "Shop" for any directive; the person named the blog.
  const reply = await runPiAgentText({ chatId: chat, userMessage: "@blog BY-NAME write a headline" });
  assert.equal(reply, "refused by the tool");
  assert.equal(seen.filter((request) => request.system.includes("SHOP-MARKER")).length, 0);
});
await check("the permission ends with the turn", async () => {
  assert.equal(visit.visitGranted(parentChat, "shop"), false);
});
await check("a project's session has no such tool to be talked into using", async () => {
  const { tools } = await createEggentPiTools({ chatId: "x", projectId: "shop", visit: { parentChatId: "p" } });
  assert.ok(!tools.some((tool) => tool.name === "eggent_ask_project"));
  const own = await createEggentPiTools({ chatId: "y", projectId: "blog" });
  assert.ok(own.tools.some((tool) => tool.name === "eggent_ask_project"), "an ordinary chat has it");
  const only = await createEggentPiTools({ chatId: "z", projectId: "shop" });
  assert.ok(only.tools.some((tool) => tool.name === "eggent_ask_project"));
});

console.log("\nWhere there is nobody to ask\n");

await check("a public share is not handed the workspace's projects, and the message is not rewritten", async () => {
  const chat = await newChat("Shared");
  seen.length = 0;
  await runPiAgentText({ chatId: chat, userMessage: "@shop how many orders came back?", enableEggentTools: false });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].lastUser, "@shop how many orders came back?");
  assert.ok(!seen[0].tools.includes("eggent_ask_project"));
  assert.equal(seen.filter((request) => request.system.includes("SHOP-MARKER")).length, 0);
});
await check("a light chat has no such thing either", async () => {
  const chat = await newChat("Light");
  seen.length = 0;
  await runPiAgentText({ chatId: chat, userMessage: "@shop how many orders came back?", chatContextMode: "plain" });
  assert.equal(seen[0].lastUser, "@shop how many orders came back?");
  assert.ok(!seen[0].tools.includes("eggent_ask_project"));
});
await check("a handle that is not a project is an ordinary message", async () => {
  const chat = await newChat("Handle");
  seen.length = 0;
  await runPiAgentText({ chatId: chat, userMessage: "@someone_else hello there" });
  assert.equal(seen[0].lastUser, "@someone_else hello there");
});

console.log("\nWhat the person asked is the project's business\n");

await check("a schedule word in the task does not make this chat give up its own tools", async () => {
  const chat = await newChat("Schedules");
  seen.length = 0;
  await runPiAgentText({ chatId: chat, userMessage: "@shop show my scheduled tasks and delete the first one" });
  const parent = seen[0];
  assert.match(parent.lastUser, /project mention directive/);
  assert.doesNotMatch(parent.lastUser, /schedule-management directive/, "the chat itself was put into scheduling mode");
  assert.ok(parent.tools.includes("bash"), "the chat's own tools were withheld because of the project's task");
  const nested = seen.find((request) => request.lastUser.includes("schedule-management directive"));
  assert.ok(nested, "the project did not get the task as it would from the person");
  assert.ok(!nested.lastUser.includes("project mention directive"));
});
await check("a mention of the project the chat is already in is just the task", async () => {
  const chat = await newChat("Inside the shop");
  seen.length = 0;
  const reply = await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "@shop how many orders came back?" });
  assert.equal(reply, "orders: 42");
  assert.equal(seen[0].lastUser, "how many orders came back?");
});
await check("a task that itself begins with @ is not read as another mention", async () => {
  const chat = await newChat("Nested at");
  seen.length = 0;
  await runPiAgentText({ chatId: chat, userMessage: "@shop @blog how many orders came back?" });
  const nested = seen.find((request) => request.system.includes("SHOP-MARKER"));
  assert.ok(nested, "the project was never reached");
  assert.equal(nested.lastUser, "Task: @blog how many orders came back?");
});

console.log("\nIn the web chat\n");

await check("the card's data and the answer arrive in the stream", async () => {
  const chat = await newChat("From the web");
  const stream = createPiChatUIMessageStream({ chatId: chat, userMessage: "@shop how many orders came back?" });
  const reader = stream.getReader();
  const chunks: Array<Record<string, unknown>> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Record<string, unknown>);
  }
  const cards = chunks.filter((part) => part.type === "data-piSubagent").map((part) => part.data as { kind?: string; status?: string; projectName?: string });
  assert.ok(cards.length >= 2, `only ${cards.length} card updates`);
  assert.ok(cards.every((card) => card.kind === "project"));
  assert.equal(cards[cards.length - 1].status, "done");
  assert.equal(cards[cards.length - 1].projectName, "Shop");
  const text = chunks.filter((part) => part.type === "text-delta").map((part) => String(part.delta)).join("");
  assert.match(text, /relayed: orders: 42/);
});

console.log("\nStopping, and giving up\n");

await check("Stop in the chat that asked reaches into the project's work", async () => {
  const chat = await newChat("Stop me");
  const waiting = runPiAgentText({ chatId: chat, userMessage: "@shop VISIT-HANG please" });
  await sleep(2500);
  const nestedId = visit.visitChatIdFor(chat, "shop");
  assert.ok(getActiveRun(nestedId), "the project was not working");
  const started = Date.now();
  await stopActiveRun(chat);
  await waiting;
  assert.ok(Date.now() - started < 15_000, "the stop took too long");
  assert.equal(getActiveRun(nestedId), undefined, "the project is still working");
  assert.equal(getActiveRun(chat), undefined);
});
await check("a visit that takes too long is stopped, and the chat is told", async () => {
  process.env.EGGENT_VISIT_TIMEOUT_MINUTES = "0.03";
  try {
    const chat = await newChat("Too slow");
    const reply = await runPiAgentText({ chatId: chat, userMessage: "@blog VISIT-HANG please" });
    assert.match(reply, /relayed: /);
    const part = (await lastAssistantOf(chat))?.parts?.find((candidate) => candidate.type === "tool" && candidate.toolName === "eggent_ask_project");
    assert.ok(part && part.type === "tool");
    assert.notEqual(part.subagent?.status, "done");
    assert.equal(getActiveRun(visit.visitChatIdFor(chat, "blog")), undefined);
  } finally {
    delete process.env.EGGENT_VISIT_TIMEOUT_MINUTES;
  }
});

console.log("\nHow many at once\n");

await check("visits beyond the limit wait their turn", async () => {
  process.env.EGGENT_VISITS_MAX = "1";
  maxSlow = 0;
  try {
    const first = await newChat("First");
    const second = await newChat("Second");
    await Promise.all([
      runPiAgentText({ chatId: first, userMessage: "@shop VISIT-SLOW one" }),
      runPiAgentText({ chatId: second, userMessage: "@blog VISIT-SLOW two" }),
    ]);
    assert.equal(maxSlow, 1, `${maxSlow} projects were working at once`);
  } finally {
    delete process.env.EGGENT_VISITS_MAX;
  }
});

for (const socket of sockets) socket.destroy();
provider.close();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
