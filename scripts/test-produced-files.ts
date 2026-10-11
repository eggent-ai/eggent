/**
 * The files an answer made, and getting them.
 *
 * Two halves. Deciding what counts as "made by this turn" is judged on its own,
 * because precision is the whole point: a card that lists a file the agent did
 * not make teaches people to ignore the card. Then the real runners against a
 * stub model that writes a file, runs a command, and asks a project to work:
 * what is stored with the answer, what the web is sent, what a Telegram answer
 * says, and what /files does - sent to a stand-in relay that records it.
 *
 * No network. Run with Node 22:
 *   npm run test:produced-files
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

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

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
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
  req.on("data", (part) => (body += String(part)));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
    const messages = payload.messages ?? [];
    const tools = (payload.tools ?? []).map((tool) => tool.function?.name ?? "");
    const lastUser = textOf([...messages].reverse().find((message) => message.role === "user")?.content);
    const lastRole = messages[messages.length - 1]?.role ?? "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const reply = (text: string) => {
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ content: text }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const call = (name: string, args: Record<string, unknown>) => {
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ tool_calls: [{ index: 0, id: `c-${name}-${messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
    };

    // The chat's own model, told to hand a task to a project.
    const directive = /call eggent_ask_project with project="([^"]+)"/.exec(lastUser);
    if (directive && lastRole !== "tool") return call("eggent_ask_project", { project: directive[1], task: lastUser.split("Task for the project:\n")[1]?.trim() ?? "" });
    if (lastRole === "tool" && textOf(messages[messages.length - 1]?.content).startsWith("Project ")) return reply("The project made the report.");

    if (lastUser.includes("WRITE-FILE") && lastRole !== "tool") {
      return call("write", { path: "reports/summary.md", content: "# Summary\n" });
    }
    if (lastUser.includes("WRITE-TWO") && lastRole !== "tool") {
      return call("write", { path: "reports/a.md", content: "a" });
    }
    if (lastUser.includes("BASH-FILE") && lastRole !== "tool") {
      return call("bash", { command: "mkdir -p out && echo hello > out/result.txt" });
    }
    if (lastUser.includes("WRITE-FILE") && lastRole === "tool") return reply("Saved `reports/summary.md` for you.");
    if (lastUser.includes("WRITE-TWO") && lastRole === "tool") return reply("Done.");
    if (lastUser.includes("BASH-FILE") && lastRole === "tool") return reply("Done, the command ran.");
    void tools;
    return reply("plain answer");
  });
});
provider.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

// A stand-in for the deployment's relay: it records what Telegram would be sent.
const delivered: Array<{ chatId: unknown; name: string; bytes: number }> = [];
const relay = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => (body += String(part)));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body) as { chatId: unknown; name: string; contentBase64: string };
      delivered.push({ chatId: parsed.chatId, name: parsed.name, bytes: Buffer.from(parsed.contentBase64, "base64").length });
    } catch {
      // Not a document: nothing to record.
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, messageIds: [1] }));
  });
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-produced-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: { [PROVIDER]: { name: "Stub", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, api: "openai-completions", models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }] } },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
process.env.EGGENT_TELEGRAM_RELAY_URL = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
process.env.EGGENT_TELEGRAM_RELAY_TOKEN = "relay-test";

const projectStore = await import("../src/lib/storage/project-store.ts");
const produced = await import("../src/lib/files/produced.ts");
const { runPiAgentText, createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { handleExternalMessage } = await import("../src/lib/external/handle-external-message.ts");
const statRoute = await import("../src/app/api/files/stat/route.ts");
const telegramRoute = await import("../src/app/api/files/telegram/route.ts");
const { createSessionToken } = await import("../src/lib/auth/session.ts");

fs.mkdirSync(path.join(root, "data", "projects", "skills"), { recursive: true });
await projectStore.createProject({ id: "shop", name: "Shop", description: "Orders", instructions: "Shop rules.", memoryMode: "isolated" } as never);
const shopDir = path.join(root, "data", "projects", "shop");
const work = (relative: string, content = "x", ageMs = 0) => {
  const full = path.join(shopDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(full, when, when);
  }
  return full;
};

const now = () => Date.now();
const collect = (input: Partial<Parameters<typeof produced.collectProducedFiles>[0]> & { startedAt?: number }) =>
  produced.collectProducedFiles({
    tools: [],
    startedAt: now() - 60_000,
    cwd: shopDir,
    projectId: "shop",
    assistantText: "",
    ...input,
  } as never);

console.log("What counts as made by the turn\n");

await check("a file a tool wrote is a result", async () => {
  work("reports/written.md");
  const group = await collect({ tools: [{ toolName: "write", input: { path: "reports/written.md" }, status: "completed" }] });
  assert.deepEqual(group?.items.map((item) => item.path), ["reports/written.md"]);
  assert.equal(group?.items[0].source, "tool");
  assert.equal(group?.project, "shop");
});
await check("a file the answer names comes first, in code, in bold or as a link", async () => {
  work("a.md"); work("b.md"); work("c.md");
  const group = await collect({ assistantText: "Made `a.md`, **b.md** and [c](c.md)." });
  assert.deepEqual(group?.items.map((item) => item.path), ["a.md", "b.md", "c.md"]);
  assert.ok(group?.items.every((item) => item.source === "answer"));
});
await check("a file the answer names that was not touched this turn is not a result", async () => {
  work("old-notes.md", "x", 3 * 3600_000);
  assert.equal(await collect({ assistantText: "See `old-notes.md`." }), null);
});
await check("editing is touching what was there: a result only if the answer says so", async () => {
  work("edited.md");
  assert.equal(await collect({ tools: [{ toolName: "edit", input: { path: "edited.md" }, status: "completed" }] }), null);
  const named = await collect({ tools: [{ toolName: "edit", input: { path: "edited.md" }, status: "completed" }], assistantText: "I changed `edited.md`." });
  assert.deepEqual(named?.items.map((item) => item.path), ["edited.md"]);
});
await check("the agent's own housekeeping is never a result", async () => {
  work("memory.md"); work("context.md"); work("skills/x/SKILL.md"); work("tools/venv-thing.py"); work("uploads/in.png");
  const group = await collect({
    tools: ["memory.md", "context.md", "skills/x/SKILL.md", "tools/venv-thing.py", "uploads/in.png"].map((target) => ({ toolName: "write", input: { path: target }, status: "completed" })),
  });
  assert.equal(group, null);
});
await check("a file that holds credentials is never a result", async () => {
  work(".env", "KEY=sk-abcdefghijklmnopqrstuvwx"); work("deploy.pem", "x");
  const group = await collect({ tools: [".env", "deploy.pem"].map((target) => ({ toolName: "write", input: { path: target }, status: "completed" })), assistantText: "Saved `.env`." });
  assert.equal(group, null);
});
await check("a path that leaves the folder is not a result, nor is a link out of it", async () => {
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "x");
  fs.symlinkSync(outside, path.join(shopDir, "linked.txt"));
  const group = await collect({
    tools: [{ toolName: "write", input: { path: "../../../outside.txt" }, status: "completed" }, { toolName: "write", input: { path: "linked.txt" }, status: "completed" }],
    assistantText: "Saved `linked.txt` and `../../../outside.txt`.",
  });
  assert.equal(group, null);
});
await check("a tool that failed made nothing", async () => {
  work("failed.md");
  assert.equal(await collect({ tools: [{ toolName: "write", input: { path: "failed.md" }, status: "error" }] }), null);
});
await check("generated pictures are results, found in the tool's own report", async () => {
  work("generated-images/one.png");
  const output = JSON.stringify({ success: true, images: [{ path: path.join(shopDir, "generated-images/one.png") }] });
  const group = await collect({ tools: [{ toolName: "eggent_generate_image", input: {}, output, status: "completed" }] });
  assert.deepEqual(group?.items.map((item) => item.path), ["generated-images/one.png"]);
});
// The scan looks at everything new in the folder, so it gets a folder of its own:
// the files the other cases made a moment ago would all count as new.
await projectStore.createProject({ id: "scanbox", name: "Scan box", description: "", instructions: "x", memoryMode: "isolated" } as never);
const scanDir = path.join(root, "data", "projects", "scanbox");
const scanCollect = (input: Partial<Parameters<typeof produced.collectProducedFiles>[0]>) =>
  produced.collectProducedFiles({ tools: [], startedAt: now() - 1000, cwd: scanDir, projectId: "scanbox", assistantText: "", ...input } as never);
const scanWork = (relative: string, content = "x") => {
  const full = path.join(scanDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

await check("a command that made a file is found when nothing else points at a result", async () => {
  scanWork("scripted/out.csv");
  scanWork("scripted/chart.png");
  const group = await scanCollect({ tools: [{ toolName: "bash", input: { command: "make" }, status: "completed" }] });
  assert.deepEqual(group?.items.map((item) => item.path), ["scripted/chart.png", "scripted/out.csv"], JSON.stringify(group));
  assert.ok(group?.items.every((item) => item.source === "scan"));
});
await check("...but not when the answer already named one, and not when no command ran", async () => {
  scanWork("named-result.md");
  const named = await scanCollect({ tools: [{ toolName: "bash", input: {}, status: "completed" }], assistantText: "Made `named-result.md`." });
  assert.deepEqual(named?.items.map((item) => item.path), ["named-result.md"]);
  assert.ok(named?.items.every((item) => item.source === "answer"));
  assert.equal(await scanCollect({ tools: [{ toolName: "read", input: {}, status: "completed" }] }), null);
});
await check("the scan leaves out what was there before the turn", async () => {
  const group = await scanCollect({ startedAt: now() + 5000, tools: [{ toolName: "bash", input: {}, status: "completed" }] });
  assert.equal(group, null);
});
await check("a long list keeps the first few and counts the rest", async () => {
  const names = Array.from({ length: 20 }, (_, index) => `many/f${index}.md`);
  for (const name of names) work(name);
  const group = await collect({ tools: names.map((target) => ({ toolName: "write", input: { path: target }, status: "completed" })) });
  assert.equal(group?.total, 20);
  assert.equal(group?.items.length, produced.MAX_STORED_FILES);
});
await check("groups from several folders stay apart, and the same file is not listed twice", () => {
  const merged = produced.mergeProducedGroups([
    { project: "shop", items: [{ path: "a.md", size: 1, source: "tool" }], total: 1 },
    { project: "blog", items: [{ path: "post.md", size: 2, source: "tool" }], total: 1 },
    { project: "shop", items: [{ path: "a.md", size: 1, source: "answer" }, { path: "b.md", size: 3, source: "tool" }], total: 2 },
  ]);
  assert.deepEqual(merged.map((group) => [group.project, group.items.map((item) => item.path), group.total]), [["shop", ["a.md", "b.md"], 2], ["blog", ["post.md"], 1]]);
});

console.log("\nIn a real turn\n");

let chatNumber = 0;
async function newChat(title: string, projectId?: string): Promise<string> {
  chatNumber += 1;
  const id = `${String(chatNumber).padStart(8, "0")}-0000-4000-8000-000000000000`;
  await createChat(id, title, projectId);
  return id;
}
const lastAssistant = async (chatId: string) => (await getChat(chatId))?.messages.filter((message) => message.role === "assistant").pop();

await check("the stored answer carries the file its tool wrote", async () => {
  const chat = await newChat("Report", "shop");
  const outcome: { files?: import("../src/lib/files/produced.ts").ProducedGroup[]; filesSent?: boolean } = {};
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "WRITE-FILE please", outcome });
  const message = await lastAssistant(chat);
  assert.equal(message?.files?.length, 1);
  assert.equal(message?.files?.[0].project, "shop");
  assert.deepEqual(message?.files?.[0].items.map((item) => item.path), ["reports/summary.md"]);
  assert.equal(outcome.files?.length, 1);
});
await check("an answer that made nothing carries nothing", async () => {
  const chat = await newChat("Nothing", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "just talk" });
  assert.equal((await lastAssistant(chat))?.files, undefined);
});
await check("the web is sent the card with the answer, and it is the same list that was stored", async () => {
  const chat = await newChat("Web", "shop");
  const stream = createPiChatUIMessageStream({ chatId: chat, projectId: "shop", userMessage: "WRITE-FILE please" });
  const reader = stream.getReader();
  const chunks: Array<Record<string, unknown>> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Record<string, unknown>);
  }
  const card = chunks.find((part) => part.type === "data-eggentFiles");
  assert.ok(card, "no card in the stream");
  assert.deepEqual((card.data as Array<{ items: Array<{ path: string }> }>)[0].items.map((item) => item.path), ["reports/summary.md"]);
  assert.deepEqual((await lastAssistant(chat))?.files, card.data);
});
await check("a command that made a file is found by its scan", async () => {
  const chat = await newChat("Scan", "scanbox");
  await runPiAgentText({ chatId: chat, projectId: "scanbox", userMessage: "BASH-FILE please" });
  const files = (await lastAssistant(chat))?.files;
  assert.ok(files?.[0].items.some((item) => item.path === "out/result.txt"), JSON.stringify(files));
});
await check("the files a project made come back under the answer of the chat that asked", async () => {
  const chat = await newChat("From the orchestrator");
  await runPiAgentText({ chatId: chat, userMessage: "@shop WRITE-FILE for the report" });
  const files = (await lastAssistant(chat))?.files;
  const shop = files?.find((group) => group.project === "shop");
  assert.ok(shop, JSON.stringify(files));
  assert.deepEqual(shop.items.map((item) => item.path), ["reports/summary.md"]);
});

console.log("\nIn Telegram\n");

const fromTelegram = { telegram: { chatId: 4242 } };
const say = (sessionId: string, message: string, extra: Record<string, unknown> = {}) =>
  handleExternalMessage({ sessionId, message, projectId: "shop", toolRuntimeData: fromTelegram, ...extra } as never);

await check("the answer says there is a file and how to get it", async () => {
  const result = await say("tg-one", "WRITE-FILE please");
  assert.match(result.reply, /Saved `reports\/summary\.md`/);
  assert.match(result.reply, /Files from this answer: summary\.md\. Send \/files to get them here\./);
});
await check("an answer from the browser or the API gets no such line", async () => {
  const result = await handleExternalMessage({ sessionId: "api-one", message: "WRITE-FILE please", projectId: "shop" } as never);
  assert.doesNotMatch(result.reply, /Send \/files/);
});
await check("/files sends them to the chat that asked, as documents", async () => {
  delivered.length = 0;
  const result = await say("tg-one", "/files");
  assert.match(result.reply, /Sent: summary\.md\./);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].name, "summary.md");
  assert.equal(delivered[0].chatId, 4242);
  assert.ok(delivered[0].bytes > 0);
});
await check("/files costs no model call and is not a message to the agent", async () => {
  const first = await say("tg-one", "/files");
  const before = (await getChat(first.context.activeChatId))?.messages.length ?? 0;
  const second = await say("tg-one", "/files");
  const after = (await getChat(second.context.activeChatId))?.messages.length ?? 0;
  assert.equal(after, before);
});
await check("with nothing to send it says so", async () => {
  const result = await say("tg-fresh", "/files");
  assert.match(result.reply, /There are no files from the last answer/);
});
await check("more than three files go as one archive", async () => {
  const chat = await newChat("Many", "shop");
  const stored = await getChat(chat);
  assert.ok(stored);
  const items = Array.from({ length: 5 }, (_, index) => {
    work(`bundle/f${index}.md`, `file ${index}`);
    return { path: `bundle/f${index}.md`, size: 8, source: "tool" as const };
  });
  stored.messages.push({ id: "m1", role: "assistant", content: "Made five files.", createdAt: new Date().toISOString(), files: [{ project: "shop", items, total: 5 }] });
  const { saveChat } = await import("../src/lib/storage/chat-store.ts");
  await saveChat(stored);
  delivered.length = 0;
  const result = await handleExternalMessage({ sessionId: "tg-many", message: "/files", chatId: chat, projectId: "shop", toolRuntimeData: { telegram: { chatId: 4242 } } } as never);
  assert.match(result.reply, /Sent 5 files as one archive/);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].name, "files.zip");
});
await check("a file that is gone is said to be gone, not sent as nothing", async () => {
  const chat = await newChat("Gone", "shop");
  const stored = await getChat(chat);
  assert.ok(stored);
  stored.messages.push({ id: "m2", role: "assistant", content: "Made one.", createdAt: new Date().toISOString(), files: [{ project: "shop", items: [{ path: "vanished.md", size: 1, source: "tool" }], total: 1 }] });
  const { saveChat } = await import("../src/lib/storage/chat-store.ts");
  await saveChat(stored);
  delivered.length = 0;
  const result = await handleExternalMessage({ sessionId: "tg-gone", message: "/files", chatId: chat, projectId: "shop", toolRuntimeData: { telegram: { chatId: 4242 } } } as never);
  assert.match(result.reply, /no longer there/);
  assert.equal(delivered.length, 0);
});

console.log("\nThe routes\n");

const token = await createSessionToken("tester", false);
const request = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `eggent_auth=${token}`, ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

await check("the card can ask which files are still there", async () => {
  const response = await statRoute.GET(request("/api/files/stat?project=shop&path=reports/summary.md&path=vanished.md&path=..%2F..%2Fescape.md&path=linked.txt"));
  const body = await response.json() as { files: Array<{ path: string; exists: boolean }> };
  const byPath = new Map(body.files.map((file) => [file.path, file.exists]));
  assert.equal(byPath.get("reports/summary.md"), true);
  assert.equal(byPath.get("vanished.md"), false);
  assert.equal(byPath.get("../../escape.md"), false);
  assert.equal(byPath.get("linked.txt"), false, "a link out of the folder is not a file of it");
});
await check("sending from the browser needs a session, this site and JSON", async () => {
  const send = (headers: Record<string, string>, cookie = true) =>
    telegramRoute.POST(new NextRequest("http://localhost/api/files/telegram", {
      method: "POST",
      headers: { ...(cookie ? { cookie: `eggent_auth=${token}` } : {}), "content-type": "application/json", ...headers },
      body: JSON.stringify({ project: "shop", path: "reports/summary.md" }),
    }));
  assert.equal((await send({}, false)).status, 401);
  assert.equal((await send({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
  const plain = await telegramRoute.POST(new NextRequest("http://localhost/api/files/telegram", {
    method: "POST", headers: { cookie: `eggent_auth=${token}`, "content-type": "text/plain" }, body: JSON.stringify({ project: "shop", path: "reports/summary.md" }),
  }));
  assert.equal(plain.status, 415);
});
await check("a file in the workspace goes to the person's own chat", async () => {
  // The workspace remembers where the person last wrote from.
  fs.writeFileSync(path.join(root, "data", "telegram-outbox.json"), JSON.stringify({ chatId: 4242, via: "relay" }));
  delivered.length = 0;
  const response = await telegramRoute.POST(new NextRequest("http://localhost/api/files/telegram", {
    method: "POST",
    headers: { cookie: `eggent_auth=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", path: "reports/summary.md" }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].name, "summary.md");
});
await check("what holds credentials, or leaves the folder, is not sent", async () => {
  for (const target of [".env", "../../outside.txt", "linked.txt"]) {
    const response = await telegramRoute.POST(new NextRequest("http://localhost/api/files/telegram", {
      method: "POST",
      headers: { cookie: `eggent_auth=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ project: "shop", path: target }),
    }));
    assert.equal(response.status, 404, target);
  }
});
await check("the button is offered only where Telegram can be reached", async () => {
  const on = await (await telegramRoute.GET(request("/api/files/telegram"))).json() as { available: boolean };
  assert.equal(on.available, true);
  fs.rmSync(path.join(root, "data", "telegram-outbox.json"));
  const off = await (await telegramRoute.GET(request("/api/files/telegram"))).json() as { available: boolean };
  assert.equal(off.available, false);
});

for (const socket of sockets) socket.destroy();
provider.close();
relay.close();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
