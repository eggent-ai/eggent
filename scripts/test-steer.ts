/**
 * A message sent while the agent works reaches the turn, and the chat shows it
 * where the agent read it.
 *
 * Run with Node 22: npm run test:steer
 *
 * The web composer used to refuse anything while a turn ran, so the one way to
 * correct the agent was Stop: the answer in progress was thrown away and the
 * request typed again (ten times in one week for one person alone). The
 * runtime could always take a message in the middle - `steer` - and these are
 * the real runners against a local stub provider, with the message sent the way
 * the screen sends it: during a command, during the final text, three at once,
 * at the moment the turn ends, before a stop, with a file, as a command.
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

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
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

/** For each conversation (by the first word said), the people's messages each model call was sent, in order. */
const calls = new Map<string, string[][]>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = payload.messages ?? [];
    const users = messages.filter((message) => message.role === "user").map(contentOf);
    const key = (users[0] ?? "").split(" ")[0];
    calls.set(key, [...(calls.get(key) ?? []), users]);
    const toolResults = messages.filter((message) => message.role === "tool").length;
    const later = users.slice(1).filter((text) => !text.startsWith("[Eggent]"));

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    const toolCall = (command: string) => {
      res.write(chunk({
        tool_calls: [{ index: 0, id: `call-${key}-${toolResults}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
      }));
      res.write(chunk({}, "tool_calls"));
    };

    if (key === "TEXT" && later.length === 0) {
      // Writes its answer slowly: the message arrives while it is still writing.
      for (const word of ["The ", "table ", "is ", "nearly ", "ready."]) {
        res.write(chunk({ content: word }));
        await sleep(250);
      }
      res.write(chunk({}, "stop"));
    } else if ((key === "TOOL" || key === "MULTI" || key === "FILE" || key === "TG") && toolResults === 0) {
      toolCall("sleep 2");
    } else if (key === "STOP" && toolResults === 0) {
      toolCall("sleep 20");
    } else if (key === "END" && later.length === 0) {
      // A short answer whose end comes a moment after its words.
      res.write(chunk({ content: "DONE" }));
      await sleep(60);
      res.write(chunk({}, "stop"));
    } else if (later.length > 0) {
      res.write(chunk({ content: `ACK ${later.join(" | ")}` }));
      res.write(chunk({}, "stop"));
    } else {
      res.write(chunk({ content: "DONE" }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-steer-"));
process.chdir(root);
const agentDir = path.join(root, "data", "pi-agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_AUTH_SECRET = "steer-test-secret-0123456789abcdef";
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: providerUrl,
      api: "openai-completions",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
    },
  },
}, null, 2));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }, null, 2));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: PROVIDER,
  defaultModel: MODEL,
  packages: [],
  retry: { enabled: false },
}, null, 2));

const { createPiChatUIMessageStream, runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { joinActiveRun, getActiveRun, stopActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { whenLiveRunFinished } = await import("../src/lib/pi/live-run.ts");
const { saveChatFile } = await import("../src/lib/storage/chat-files-store.ts");
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const { NextRequest } = await import("next/server");
const steerRoute = await import("../src/app/api/chat/[chatId]/steer/route.ts");

type Chunk = { type: string; id?: string; data?: unknown; toolName?: string };

/** A web turn, read the way the screen reads it; `during` runs once the turn is working. */
async function webTurn(
  chatId: string,
  userMessage: string,
  during?: (chunks: Chunk[]) => Promise<void>,
  options: { existing?: boolean; userMessageId?: string } = {}
): Promise<Chunk[]> {
  if (!options.existing) await createChat(chatId, userMessage);
  const chunks: Chunk[] = [];
  const reader = createPiChatUIMessageStream({
    chatId,
    userMessage,
    cwd,
    agentDir,
    runId: `run-${chatId}-${crypto.randomUUID()}`,
    ...(options.userMessageId ? { userMessageId: options.userMessageId } : {}),
  }).getReader();
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value as Chunk);
    }
  })();
  if (during) await during(chunks);
  await drained;
  await whenLiveRunFinished(chatId);
  return chunks;
}

async function until(test: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

const toolStarted = (chunks: Chunk[]) => chunks.some((part) => part.type === "tool-input-available");

async function shape(chatId: string): Promise<string[]> {
  const chat = await getChat(chatId);
  assert.ok(chat, "the chat is gone");
  return chat.messages
    .filter((message) => message.role !== "tool")
    .map((message) => `${message.role}${message.steer ? `[${message.steer.state}]` : ""}:${message.content.slice(0, 40)}`);
}

console.log("web chat:");

const TOOL = "00000001-aaaa-4bbb-8ccc-000000000001";
let toolOutcome: string | null = null;
const toolChunks = await webTurn(TOOL, "TOOL make the purchase table", async (chunks) => {
  await until(() => toolStarted(chunks), "the command to start");
  toolOutcome = await joinActiveRun(TOOL, "STEER use the April supplier list", { messageId: "steer-tool-0001" });
});
await check("a message sent during a command reaches the turn before its next model call", async () => {
  assert.equal(toolOutcome, "steered");
  const turns = calls.get("TOOL") ?? [];
  assert.equal(turns.length, 2, `the model was asked ${turns.length} time(s)`);
  assert.deepEqual(turns[1].slice(1), ["STEER use the April supplier list"]);
});
await check("the stored chat shows it where the agent read it, between the two halves of the answer", async () => {
  const stored = await shape(TOOL);
  assert.deepEqual(stored, [
    "user:TOOL make the purchase table",
    "assistant:",
    "user[delivered]:STEER use the April supplier list",
    "assistant:ACK STEER use the April supplier list",
  ]);
  const chat = await getChat(TOOL);
  assert.equal(chat?.messages.find((message) => message.role === "assistant")?.toolCalls?.[0]?.toolName, "bash", "the command stayed with the first half");
});
await check("the stream says where it was read, and the queue empties", async () => {
  const delivered = toolChunks.filter((part) => part.type === "data-piSteer");
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0].data as { messageId?: string }).messageId, "steer-tool-0001");
  const queues = toolChunks.filter((part) => part.type === "data-piSteerQueue").map((part) => (part.data as { items: unknown[] }).items.length);
  assert.deepEqual([queues[0], queues[queues.length - 1]], [1, 0]);
});

const TEXT = "00000002-aaaa-4bbb-8ccc-000000000002";
let textOutcome: string | null = null;
await webTurn(TEXT, "TEXT write the summary", async (chunks) => {
  await until(() => chunks.some((part) => part.type === "text-delta"), "the answer to start");
  textOutcome = await joinActiveRun(TEXT, "STEER and add a total row");
});
await check("a message sent while the final answer is being written is read once it is written, and answered", async () => {
  assert.equal(textOutcome, "steered");
  const stored = await shape(TEXT);
  assert.deepEqual(stored, [
    "user:TEXT write the summary",
    "assistant:The table is nearly ready.",
    "user[delivered]:STEER and add a total row",
    "assistant:ACK STEER and add a total row",
  ]);
});

const MULTI = "00000003-aaaa-4bbb-8ccc-000000000003";
const multiOutcomes: Array<string | null> = [];
await webTurn(MULTI, "MULTI make the table", async (chunks) => {
  await until(() => toolStarted(chunks), "the command to start");
  for (const text of ["STEER one", "STEER two", "STEER three"]) multiOutcomes.push(await joinActiveRun(MULTI, text));
});
await check("three quick messages reach the agent together, in one model call", async () => {
  assert.deepEqual(multiOutcomes, ["steered", "steered", "steered"]);
  const turns = calls.get("MULTI") ?? [];
  assert.equal(turns.length, 2, `the model was asked ${turns.length} times`);
  assert.deepEqual(turns[1].slice(1), ["STEER one", "STEER two", "STEER three"]);
  const stored = await shape(MULTI);
  assert.deepEqual(stored.slice(2, 5), ["user[delivered]:STEER one", "user[delivered]:STEER two", "user[delivered]:STEER three"]);
});

const STOP = "00000004-aaaa-4bbb-8ccc-000000000004";
await webTurn(STOP, "STOP make the table", async (chunks) => {
  await until(() => toolStarted(chunks), "the command to start");
  assert.equal(await joinActiveRun(STOP, "STEER never read", { messageId: "steer-stop-0001" }), "steered");
  assert.equal(await stopActiveRun(STOP), true);
});
await check("a message the turn never read is kept, marked, after the stopped answer", async () => {
  const stored = await shape(STOP);
  assert.equal(stored[stored.length - 1], "user[undelivered]:STEER never read");
  assert.equal((calls.get("STOP") ?? []).length, 1, "a stopped turn went on to ask the model");
});
await check("the stopped turn is gone: what comes next starts a turn of its own", async () => {
  assert.equal(getActiveRun(STOP), undefined);
  assert.equal(await joinActiveRun(STOP, "anything"), null);
});

await webTurn(STOP, "STEER never read", undefined, { existing: true, userMessageId: "steer-stop-0001" });
await check("sending it again as a turn of its own keeps one copy, an ordinary message now, with its answer after it", async () => {
  const stored = await shape(STOP);
  assert.equal(stored.filter((line) => line.startsWith("user") && line.includes("STEER never read")).length, 1, stored.join(" / "));
  assert.deepEqual(stored.slice(-2), ["user:STEER never read", "assistant:ACK STEER never read"]);
});

// The moment the turn ends: whatever the person sent then either reached it or starts a turn of its own,
// and nothing that was taken is lost. One message per turn, sent a little later each time, so one of
// them lands in the last moments of the turn.
const endOutcomes: Array<{ chatId: string; text: string; outcome: string | null }> = [];
for (const delay of [0, 20, 40, 50, 55, 60, 63, 66, 70, 75, 80, 90, 100, 150]) {
  const chatId = `00000008-aaaa-4bbb-8ccc-${String(delay).padStart(12, "0")}`;
  await webTurn(chatId, "END quick question", async (chunks) => {
    await until(() => chunks.some((part) => part.type === "text-delta"), "the answer to start");
    await sleep(delay);
    const text = `STEER late ${delay}`;
    endOutcomes.push({ chatId, text, outcome: await joinActiveRun(chatId, text) });
  });
}
await check("a message sent as a turn ends is either read, kept as not read, or starts a turn of its own - never lost", async () => {
  for (const { chatId, text, outcome } of endOutcomes) {
    if (outcome !== "steered") {
      assert.equal(outcome, null, `"${text}" came back ${outcome}`);
      continue;
    }
    const chat = await getChat(chatId);
    const stored = chat?.messages.find((message) => message.content === text);
    assert.ok(stored?.steer && (stored.steer.state === "delivered" || stored.steer.state === "undelivered"), `"${text}" was taken and is ${stored?.steer?.state ?? "missing"}`);
  }
  assert.ok(endOutcomes.some(({ outcome }) => outcome === "steered"), "no message reached a turn");
  assert.ok(endOutcomes.some(({ outcome }) => outcome === null), "no message came after the end");
});

const FILE = "00000005-aaaa-4bbb-8ccc-000000000005";
// A file the chat had before the turn: the turn knows it already, and it was not sent with the message.
await saveChatFile(FILE, Buffer.from("old"), "old-contract.pdf");
await webTurn(FILE, "FILE look at the plan", async (chunks) => {
  await until(() => toolStarted(chunks), "the command to start");
  const saved = await saveChatFile(FILE, Buffer.from("plan"), "plan-v2.pdf");
  const request = new NextRequest(`http://workspace.example.test/api/chat/${FILE}/steer`, {
    method: "POST",
    headers: {
      cookie: `${AUTH_COOKIE_NAME}=${await createSessionToken("owner@example.test", false)}`,
      origin: "http://workspace.example.test",
      host: "workspace.example.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "STEER the new plan is attached", messageId: "steer-file-0001", files: [saved.name, "../../etc/passwd"] }),
  });
  const response = await steerRoute.POST(request, { params: Promise.resolve({ chatId: FILE }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "steered", messageId: "steer-file-0001" });
});
await check("a file sent with the message is named to the agent by the path to read it, and nothing else is", () => {
  const turns = calls.get("FILE") ?? [];
  const said = turns[1]?.[1] ?? "";
  assert.match(said, /plan-v2\.pdf/);
  assert.match(said, /chat-files/);
  assert.doesNotMatch(said, /passwd/);
  assert.doesNotMatch(said, /old-contract/);
});

const COMMAND = "00000006-aaaa-4bbb-8ccc-000000000006";
let commandOutcome: string | null = null;
await webTurn(COMMAND, "TOOL check the command", async (chunks) => {
  await until(() => toolStarted(chunks), "the command to start");
  commandOutcome = await joinActiveRun(COMMAND, "/skill:first-document now");
});
await check("a command sent in the middle is refused, and no second turn starts beside the first", () => {
  assert.equal(commandOutcome, "refused");
});

await check("the route turns away a request without a session, from another site, or not in JSON", async () => {
  const base = { method: "POST", body: JSON.stringify({ message: "x" }) };
  const cookie = `${AUTH_COOKIE_NAME}=${await createSessionToken("owner@example.test", false)}`;
  const go = (headers: Record<string, string>) =>
    steerRoute.POST(new NextRequest(`http://workspace.example.test/api/chat/${TOOL}/steer`, { ...base, headers: { host: "workspace.example.test", ...headers } }), { params: Promise.resolve({ chatId: TOOL }) });
  assert.equal((await go({ "content-type": "application/json" })).status, 401);
  assert.equal((await go({ cookie, origin: "http://other.example.test", "content-type": "application/json" })).status, 403);
  assert.equal((await go({ cookie, "content-type": "text/plain" })).status, 415);
  const idle = await go({ cookie, "content-type": "application/json" });
  assert.equal((await idle.json() as { status: string }).status, "not-running");
});

console.log("\nmessenger:");

const TG = "00000007-aaaa-4bbb-8ccc-000000000007";
await createChat(TG, "Telegram");
const running = runPiAgentText({ chatId: TG, userMessage: "TG make the table", cwd, agentDir });
await until(() => (calls.get("TG") ?? []).length >= 1, "the messenger's turn to ask the model");
await sleep(300);
const tgOutcome = await joinActiveRun(TG, "STEER from the phone");
const reply = await running;
await check("a message added to a messenger's turn is read, answered and stored where it was read", async () => {
  assert.equal(tgOutcome, "steered");
  assert.match(reply, /ACK STEER from the phone/);
  const stored = await shape(TG);
  assert.deepEqual(stored.slice(-3), ["assistant:", "user[delivered]:STEER from the phone", "assistant:ACK STEER from the phone"]);
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
