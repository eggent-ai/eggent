/**
 * Each scheduled run reports into a chat of its own.
 *
 * Run with Node 22: npm run test:scheduled-run-chat
 *
 * Every run used to land in the chat the task was set up in, so a month of
 * mornings sat in one conversation, and the report reached Telegram from a
 * chat the person was no longer in: their answer to it went elsewhere, to an
 * agent that had never seen the report. A run now writes into a chat of its
 * own - one per task and day - whose context holds what the run did, and the
 * report says which chat it is from and moves the conversation there.
 *
 * Runs the real session runtime against a local stub provider, and drives a
 * scheduled run the way pi-subagents does: a finished job's notification sent
 * into the session that owns the schedule, which starts a turn of its own.
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
const SETUP = "Every morning, go through my todo list.";
const REPORT = "**Today**: finish the platform.";
const REFUSAL = "Request not carried out: the limit for this workspace has been reached. Details: https://example.test/limits";

function chunk(delta: Record<string, unknown>, finish: string | null = null, id = "stub-completion"): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/**
 * Answers the setup with a line, and a finished job's notification with the
 * report. A notification marked SEND-ITSELF is answered the way the morning job
 * on a real workspace does it: the agent sends the reminder with the Telegram
 * tool, then closes with a remark.
 */
/** What the model was sent in each report turn, and in every other turn. */
const reportRequests: string[] = [];
const otherRequests: string[] = [];
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
    const messages = payload.messages ?? [];
    const last = [...messages].reverse().find((message) => message.role === "user");
    const lastText = JSON.stringify(last?.content ?? "");
    const toolAnswered = messages[messages.length - 1]?.role === "tool";
    (lastText.includes("task-notification") ? reportRequests : otherRequests).push(JSON.stringify(messages));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // The deployment's gateway answers a request it turns away with a reply of its
    // own, under an id of its own, that finishes normally and spends nothing.
    if (lastText.includes("REFUSE")) {
      res.write(chunk({ role: "assistant" }, null, "eggent_limit_1"));
      res.write(chunk({ content: REFUSAL }, null, "eggent_limit_1"));
      res.write(chunk({}, "stop", "eggent_limit_1"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.write(chunk({ role: "assistant" }));
    if (lastText.includes("EMPTY-REPORT")) {
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (lastText.includes("SEND-ITSELF") && !toolAnswered) {
      res.write(chunk({
        tool_calls: [{
          index: 0,
          id: "stub-send-1",
          type: "function",
          function: { name: "telegram_send_message", arguments: JSON.stringify({ text: "Reminder: finish the platform." }) },
        }],
      }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ content: toolAnswered ? "The reminder is sent." : lastText.includes("task-notification") ? REPORT : "Done, it is scheduled." }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

/** The deployment's relay: records what it was asked to send and numbers it. */
const relayed: Array<{ path: string; body: Record<string, unknown> }> = [];
let nextRelayId = 100;
const relay = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => {
    body += String(part);
  });
  req.on("end", () => {
    relayed.push({ path: req.url || "", body: JSON.parse(body || "{}") });
    nextRelayId += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, messageIds: [nextRelayId], sessionId: "cloud-telegram:42" }));
  });
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-scheduled-run-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir);
fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_TELEGRAM_RELAY_URL = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
process.env.EGGENT_TELEGRAM_RELAY_TOKEN = "relay-test-token";
delete process.env.TELEGRAM_BOT_TOKEN;
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

const { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent");
const { openChatSessionManager, getEggentPiSessionDir } = await import("../src/lib/pi/session-files.ts");
const scheduleHost = await import("../src/lib/pi/schedule-host.ts");
const { createChat, getAllChats, getChat } = await import("../src/lib/storage/chat-store.ts");
const { rememberTelegramDestination } = await import("../src/lib/telegram/outbound.ts");
const { chatForTelegramMessage, RELAY_BOT_KEY } = await import("../src/lib/telegram/conversation.ts");
const { getExternalSession } = await import("../src/lib/storage/external-session-store.ts");
const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");
const { createSchedulePolicyExtension } = await import("../src/lib/pi/schedule-policy.ts");
const { isScheduledRunSessionId, SCHEDULED_RUN_REFUSAL } = await import("../src/lib/pi/scheduled-run-state.ts");

const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
const registry = new ModelRegistry(runtime);
await registry.refresh();
const model = registry.getAll().find((entry) => entry.provider === PROVIDER && entry.id === MODEL);
assert.ok(model, "the stub model did not reach the registry");

const OWNER = "0000aaaa-1111-4222-8333-444455556666";
await createChat(OWNER, "Every morning, go through my todo list");
// The workspace's real Telegram tool, bound to the owner chat as a live
// session's tools are.
let sessionRef: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
const eggentTools = await createEggentPiTools({ chatId: OWNER, cwd, getAgentSession: () => sessionRef });
const sendTool = eggentTools.tools.find((tool) => tool.name === "telegram_send_message");
assert.ok(sendTool, "the Telegram tool is missing");
// The workspace's own schedule policy, as every real session carries it, loaded
// before the session is built as session.ts does.
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  noSkills: true,
  extensionFactories: [createSchedulePolicyExtension(isScheduledRunSessionId, SCHEDULED_RUN_REFUSAL)],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime: runtime,
  resourceLoader,
  tools: ["telegram_send_message"],
  customTools: [sendTool],
  sessionManager: openChatSessionManager(OWNER, cwd),
});
sessionRef = session;
// A real session binds its extensions when it is built; without it none of
// their hooks run until the first reload.
await session.bindExtensions({ onError: () => {} });
await session.prompt(SETUP);

// What pi-subagents keeps: the job, stamped when its helper finished.
const storeDir = path.join(cwd, ".pi", "subagent-schedules");
fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, `${session.sessionId}.json`), JSON.stringify({
  version: 1,
  jobs: [{
    id: "job-morning",
    name: "Morning review",
    description: "morning review",
    schedule: "0 0 6 * * *",
    scheduleType: "cron",
    enabled: true,
    lastRun: new Date().toISOString(),
    lastStatus: "completed",
  }],
}, null, 2));

// The person last wrote through the deployment's bot, under a session that has
// since been replaced; the relay knows the current one.
await rememberTelegramDestination({ chatId: 42, via: "relay", sessionId: "cloud-telegram:42:stale" });

const retained = await scheduleHost.retainPiScheduleSession({ chatId: OWNER, projectId: null, session });
assert.equal(retained, true, "the owner session was not kept for its schedule");

// Next compiles the boot hook and each route on its own, so a module-level Map
// is one copy per compiled module. A second copy of the module has to see the
// session the first one retained, or a retime, a delete or a pause from route
// code cannot find the session holding the timers.
await check("the registry is shared by every copy of the module", async () => {
  // A variable, so the type checker does not try to resolve the query string.
  const secondCopy = "../src/lib/pi/schedule-host.ts?second-copy";
  const second = (await import(secondCopy)) as typeof scheduleHost;
  assert.notEqual(second.listRetainedPiScheduleSessions, scheduleHost.listRetainedPiScheduleSessions, "this is the same copy, so the check proves nothing");
  assert.ok(
    second.listRetainedPiScheduleSessions().some((entry) => entry.chatId === OWNER),
    "a second copy of the module cannot see the retained session"
  );
});

async function fireRun(
  marker = "",
  options: { sends?: boolean; details?: Record<string, unknown> } = {}
): Promise<void> {
  const before = relayed.length;
  await session.sendCustomMessage({
    customType: "subagent-notification",
    content: `<task-notification>\n<summary>Agent "morning review" completed</summary>\n<result>todo: finish the platform ${marker}</result>\n</task-notification>`,
    display: true,
    details: { description: "morning review", ...options.details },
  }, { triggerTurn: true, deliverAs: "followUp" });
  await session.waitForIdle();
  // The report is written and sent after the turn settles. A run that is kept
  // and not sent has nothing to wait for, so give it a moment instead.
  for (let waited = 0; waited < (options.sends === false ? 400 : 5000) && relayed.length === before; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function runChats() {
  return (await getAllChats()).filter((chat) => chat.scheduledJob);
}

console.log("A scheduled run reports into a chat of its own\n");

await fireRun();
const [runChatItem] = await runChats();
const today = new Date();
const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][today.getUTCMonth()];

await check("the report turn is told its reply is the result itself, and nothing else is", () => {
  assert.ok(reportRequests.length > 0, "no report turn reached the model");
  assert.ok(
    reportRequests.every((request) => request.includes("this turn reports a scheduled run")),
    "the report turn was not told that its reply is what the person receives"
  );
  assert.ok(
    otherRequests.every((request) => !request.includes("this turn reports a scheduled run")),
    "a turn that is not a report was given the report guidance"
  );
});

await check("the guidance is sent, never stored", () => {
  const sessionDir = getEggentPiSessionDir();
  const stored = fs.readdirSync(sessionDir, { recursive: true })
    .map((name) => path.join(sessionDir, String(name)))
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => fs.readFileSync(file, "utf-8"))
    .join("\n");
  assert.ok(stored.includes("todo: finish the platform"), "the run's notification was not stored where the test looks");
  assert.ok(!stored.includes("this turn reports a scheduled run"), "the guidance was written into the session");
});

await check("the run makes a chat named after the task and the day", () => {
  assert.ok(runChatItem, "no chat was made for the run");
  assert.equal(runChatItem.title, `Morning review · ${monthShort} ${today.getUTCDate()}`);
  assert.equal(runChatItem.scheduledJob, "Morning review");
});

await check("the report is in that chat, and the setup chat is left as it was", async () => {
  const runChat = await getChat(runChatItem.id);
  assert.ok(runChat?.messages.some((message) => message.role === "assistant" && message.content === REPORT));
  assert.equal(runChat?.scheduledRun?.ownerChatId, OWNER);
  const owner = await getChat(OWNER);
  assert.equal(owner?.messages.length, 0, "the run was written into the chat the task was set up in");
});

await check("the run's chat carries the run as context, and nothing from before it", () => {
  const sessionDir = getEggentPiSessionDir();
  const file = fs.readdirSync(sessionDir).find((name) => name.endsWith(`_${runChatItem.id}.jsonl`));
  assert.ok(file, "the run's chat has no context of its own, so a reply would reach an agent that never saw the report");
  const context = SessionManager.open(path.join(sessionDir, file), sessionDir, cwd).buildSessionContext();
  const text = JSON.stringify(context.messages);
  assert.ok(text.includes("task-notification"), "the job's notification is missing");
  assert.ok(text.includes("finish the platform"), "the report is missing");
  assert.ok(!text.includes(SETUP), "the setup conversation leaked into the run's chat");
});

await check("the report goes to Telegram rendered, saying which chat it is from", () => {
  const message = relayed.find((entry) => entry.path.endsWith("/message"));
  assert.ok(message, "nothing was delivered");
  assert.equal(message.body.format, "markdown");
  assert.equal(message.body.projectName, null, "the relay was not told the conversation left any project");
  assert.equal(message.body.chatId, 42);
  assert.ok(String(message.body.text).includes(`💬 ${runChatItem.title}`), String(message.body.text));
});

await check("a reply to the report finds the run's chat", async () => {
  const back = await chatForTelegramMessage({ botKey: RELAY_BOT_KEY, telegramChatId: 42, messageId: 101 });
  assert.equal(back, runChatItem.id);
});

await check("the conversation the relay names moves to the run's chat", async () => {
  assert.equal((await getExternalSession("cloud-telegram:42"))?.activeChatId, runChatItem.id);
  assert.equal(await getExternalSession("cloud-telegram:42:stale"), null, "the stale session was bound instead");
});

console.log("\nThe next run the same day\n");

await fireRun();

await check("it shares the day's chat rather than making another", async () => {
  const chats = await runChats();
  assert.equal(chats.length, 1, `made ${chats.length} chats`);
  const runChat = await getChat(runChatItem.id);
  assert.equal(runChat?.messages.filter((message) => message.role === "assistant").length, 2);
});

await check("and its context holds both runs", () => {
  const sessionDir = getEggentPiSessionDir();
  const file = fs.readdirSync(sessionDir).find((name) => name.endsWith(`_${runChatItem.id}.jsonl`))!;
  const context = SessionManager.open(path.join(sessionDir, file), sessionDir, cwd).buildSessionContext();
  assert.equal(JSON.stringify(context.messages).split("task-notification").length - 1, 4, "expected two notifications");
});

console.log("\nA run that writes to Telegram itself\n");

const beforeOwnSend = relayed.length;
await fireRun("SEND-ITSELF");
const ownSends = relayed.slice(beforeOwnSend);

await check("its own message is the only one, and says which chat it is from", () => {
  assert.equal(ownSends.length, 1, `sent ${ownSends.length}: ${ownSends.map((entry) => entry.body.text).join(" | ")}`);
  const text = String(ownSends[0].body.text);
  assert.ok(text.startsWith("Reminder: finish the platform."), text);
  assert.ok(text.includes(`💬 ${runChatItem.title}`), text);
});

await check("a reply to it reaches the run's chat", async () => {
  const back = await chatForTelegramMessage({ botKey: RELAY_BOT_KEY, telegramChatId: 42, messageId: nextRelayId });
  assert.equal(back, runChatItem.id);
});

await check("the run, closing remark included, is kept in the run's chat", async () => {
  const runChat = await getChat(runChatItem.id);
  const last = runChat?.messages.filter((message) => message.role === "assistant").pop();
  assert.equal(last?.content, "The reminder is sent.");
  assert.ok(runChat?.messages.some((message) => message.role === "tool" && message.toolName === "telegram_send_message"));
});

console.log("\nA task that meets the wall every time\n");

const jobFile = path.join(storeDir, `${session.sessionId}.json`);
const readJobRecord = () => JSON.parse(fs.readFileSync(jobFile, "utf-8")).jobs[0];
const healthFile = path.join(root, "data", "schedules", "health.json");
const runChatNow = async () => (await getChat(runChatItem.id))!;
const assistantTexts = async () => (await runChatNow()).messages.filter((message) => message.role === "assistant").map((message) => message.content);

const beforeRefusals = relayed.length;
await fireRun("REFUSE");

await check("the first refusal is delivered, as the report it is", () => {
  const sent = relayed.slice(beforeRefusals).filter((entry) => entry.path.endsWith("/message"));
  assert.equal(sent.length, 1, `sent ${sent.length}`);
  assert.ok(String(sent[0].body.text).includes("limit for this workspace has been reached"), String(sent[0].body.text));
  assert.equal(readJobRecord().enabled, true, "paused after one refusal");
});

await fireRun("REFUSE", { sends: false });

await check("the second is kept in the run's chat and not sent again", async () => {
  assert.equal(relayed.length - beforeRefusals, 1, "a repeat refusal reached Telegram");
  const texts = await assistantTexts();
  assert.ok(texts.filter((text) => String(text).includes("limit for this workspace")).length >= 2, "the repeat was not kept");
  assert.equal(JSON.parse(fs.readFileSync(healthFile, "utf-8")).jobs[`${session.sessionId}:job-morning`].streak, 2);
  assert.equal(readJobRecord().enabled, true);
});

await fireRun("REFUSE");

await check("the third pauses the task, in its store, with the reason", () => {
  const job = readJobRecord();
  assert.equal(job.enabled, false, "the task is still on");
  assert.equal(job.pausedBy, "eggent");
  assert.equal(job.pausedReason, "refused");
  assert.ok(String(job.pausedDetail).includes("limit for this workspace"), String(job.pausedDetail));
});

await check("and tells the person once, in words, how to resume it", () => {
  const sent = relayed.slice(beforeRefusals).filter((entry) => entry.path.endsWith("/message"));
  assert.equal(sent.length, 2, `sent ${sent.length}: the repeat refusals must stay quiet`);
  const text = String(sent[1].body.text);
  assert.ok(text.includes('"Morning review" is paused'), text);
  assert.ok(text.includes("resume it"), text);
});

await check("the notice is in the run's chat, and in what an answer to it would be read against", async () => {
  const texts = await assistantTexts();
  assert.ok(String(texts[texts.length - 1]).includes("is paused"), String(texts[texts.length - 1]));
  const sessionDir = getEggentPiSessionDir();
  const file = fs.readdirSync(sessionDir).find((name) => name.endsWith(`_${runChatItem.id}.jsonl`))!;
  const context = SessionManager.open(path.join(sessionDir, file), sessionDir, cwd).buildSessionContext();
  assert.ok(JSON.stringify(context.messages).includes("is paused"), "a reply to the notice would reach an agent that never saw it");
});

await check("a paused task can be resumed, and its count starts again", async () => {
  const result = await scheduleHost.managePiSchedules({ action: "update", scope: "current", cwd, jobId: "job-morning", enabled: true });
  assert.equal((result as { updated?: boolean }).updated, true, JSON.stringify(result));
  const job = readJobRecord();
  assert.equal(job.enabled, true);
  assert.equal(job.pausedBy, undefined);
  const stored = JSON.parse(fs.readFileSync(healthFile, "utf-8"));
  assert.equal(stored.jobs[`${session.sessionId}:job-morning`], undefined);
});

console.log("\nA run that did not finish\n");

const beforeFailure = relayed.length;
await fireRun("EMPTY-REPORT", { details: { status: "error", error: "The helper stopped after 30 turns." } });

await check("with nothing to report, the person is told it did not finish, and why", () => {
  const sent = relayed.slice(beforeFailure).filter((entry) => entry.path.endsWith("/message"));
  assert.equal(sent.length, 1, `sent ${sent.length}`);
  const text = String(sent[0].body.text);
  assert.ok(text.includes('"Morning review" did not finish'), text);
  assert.ok(text.includes("stopped after 30 turns"), text);
  assert.equal(readJobRecord().enabled, true, "one failure must not pause a task");
});

await fireRun();

await check("a run that goes well clears the count", () => {
  const stored = JSON.parse(fs.readFileSync(healthFile, "utf-8"));
  assert.equal(stored.jobs[`${session.sessionId}:job-morning`], undefined);
});

scheduleHost.takeRetainedPiScheduleSession(OWNER)?.dispose();
provider.close();
relay.close();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
