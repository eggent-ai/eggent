/**
 * A Telegram conversation goes where the person means it to.
 *
 * Run with Node 22: npm run test:telegram-conversation
 *
 * Telegram is one thread and the workspace keeps many chats. A morning report
 * arrived from one chat while the conversation was bound to another, so the
 * answer to the report went to a chat that had never seen it. The rules now:
 * a reply goes to the chat the replied-to message came from; anything else
 * goes to the chat that wrote last; /chats lists the chats and /c_<id> opens
 * one; the agent can move the conversation itself.
 *
 * The real Telegram handler and the real external-message handler run in a
 * throwaway working directory. Only the model is replaced
 * (scripts/stubs/chat-runner.ts), and Telegram's API is a stub that numbers
 * what would have been sent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-telegram-conversation-"));
process.chdir(workdir);
process.env.PI_CODING_AGENT_DIR = path.join(workdir, "data", "pi-agent");
const BOT_TOKEN = "123456789:AAtest-token-for-a-local-test-only-00000";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
delete process.env.EGGENT_TELEGRAM_RELAY_URL;

type Sent = { method: string; body: Record<string, unknown>; messageId: number };
const sent: Sent[] = [];
let nextTelegramMessageId = 500;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.telegram.org/")) return realFetch(input, init);
  const method = url.split("/").pop() || "";
  let body: Record<string, unknown> = {};
  try {
    body = init?.body ? JSON.parse(String(init.body)) : {};
  } catch {
    body = {};
  }
  nextTelegramMessageId += 1;
  sent.push({ method, body, messageId: nextTelegramMessageId });
  return new Response(JSON.stringify({ ok: true, result: { message_id: nextTelegramMessageId } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { processTelegramUpdate } = await import("../src/lib/telegram/telegram-message-handler.ts");
const { handleExternalMessage } = await import("../src/lib/external/handle-external-message.ts");
const conversation = await import("../src/lib/telegram/conversation.ts");
const { createChat, getChat, saveChat, deleteChat } = await import("../src/lib/storage/chat-store.ts");
const { getExternalSession } = await import("../src/lib/storage/external-session-store.ts");
const { createProject } = await import("../src/lib/storage/project-store.ts");
const { chatShortId } = await import("../src/lib/storage/chat-browse.ts");

const runtime = {
  botToken: BOT_TOKEN,
  webhookSecret: "",
  publicBaseUrl: "",
  defaultProjectId: "",
  allowedUserIds: ["42"],
  mode: "polling",
  pollingInterval: 1000,
  detectedMode: "polling",
  sources: { botToken: "env", webhookSecret: "env", mode: "env" },
};
const SESSION_ID = "telegram:123456789:42";
const holder = globalThis as { __eggentTestRuns?: string[]; __eggentTestRunner?: Record<string, unknown> };

let nextUpdateId = 1000;
function update(text: string, replyTo?: number) {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      date: 0,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Test" },
      text,
      ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo, text: "the report" } } : {}),
    },
  };
}

async function say(text: string, replyTo?: number) {
  const before = sent.length;
  const runsBefore = holder.__eggentTestRuns?.length ?? 0;
  const result = await processTelegramUpdate(update(text, replyTo) as never, runtime as never);
  const answers = sent.slice(before).filter((entry) => entry.method === "sendMessage");
  return {
    result,
    answers,
    drafts: sent.slice(before).filter((entry) => entry.method === "sendMessageDraft").length,
    lastAnswer: answers[answers.length - 1],
    ranIn: holder.__eggentTestRuns?.slice(runsBefore) ?? [],
  };
}

async function sessionChat(): Promise<string | null | undefined> {
  return (await getExternalSession(SESSION_ID))?.activeChatId;
}

console.log("Where a Telegram message lands\n");

const first = await say("hello");
const chatA = first.ranIn[0];

await check("the first message starts the conversation's chat", async () => {
  assert.ok(chatA, "no turn ran");
  assert.equal(await sessionChat(), chatA);
});

await check("the answer is remembered as coming from that chat", async () => {
  assert.ok(first.lastAnswer, "nothing was sent");
  const back = await conversation.chatForTelegramMessage({
    botKey: conversation.telegramBotKey(BOT_TOKEN),
    telegramChatId: 42,
    messageId: first.lastAnswer.messageId,
  });
  assert.equal(back, chatA);
});

const project = await createProject({ id: "reports", name: "Reports", description: "", instructions: "", memoryMode: "isolated" });
const chatB = "bbbbbbbb-0000-4000-8000-000000000002";
await createChat(chatB, "Morning review · Oct 1", project.id);
const reportChat = (await getChat(chatB))!;
reportChat.messages.push({ id: "m1", role: "assistant", content: "**Today**: finish the platform.", createdAt: new Date().toISOString() });
await saveChat(reportChat);

const beforeDelivery = sent.length;
const delivery = await conversation.deliverChatToTelegram({
  chatId: chatB,
  text: "**Today**: finish the platform.",
  title: "Morning review · Oct 1",
});
const deliveredMessage = sent.slice(beforeDelivery).find((entry) => entry.method === "sendMessage");

await check("a delivery from another chat goes out rendered, saying which chat it is", () => {
  assert.equal(delivery?.success, true, delivery?.error);
  assert.ok(deliveredMessage, "nothing was delivered");
  const text = String(deliveredMessage.body.text || "");
  assert.match(text, /<b>Today<\/b>/, "markdown was not rendered");
  assert.match(text, /💬 Morning review · Oct 1/);
});

await check("and the project button under the input field follows it", () => {
  const keyboard = JSON.stringify((deliveredMessage?.body.reply_markup as { keyboard?: unknown } | undefined)?.keyboard ?? "");
  assert.match(keyboard, /Leave project Reports/);
});

await check("and moves the conversation there, with the chat's project", async () => {
  const session = await getExternalSession(SESSION_ID);
  assert.equal(session?.activeChatId, chatB);
  assert.equal(session?.activeProjectId, project.id);
});

const plain = await say("tell me more");
await check("so a plain message after it continues the report's chat", () => {
  assert.deepEqual(plain.ranIn, [chatB]);
});

await check("an answer in the same chat does not repeat where it is", () => {
  assert.doesNotMatch(String(plain.lastAnswer?.body.text || ""), /💬/);
});

const replied = await say("and about this", first.lastAnswer.messageId);
await check("a reply to an older answer goes back to that answer's chat", async () => {
  assert.deepEqual(replied.ranIn, [chatA]);
  assert.equal(await sessionChat(), chatA);
  const session = await getExternalSession(SESSION_ID);
  assert.equal(session?.activeProjectId, null, "the orchestrator chat should take the conversation out of the project");
});

await check("and the answer says which chat it is now in", async () => {
  const titleA = (await getChat(chatA))?.title;
  assert.ok(titleA);
  assert.ok(String(replied.lastAnswer?.body.text || "").includes(`💬 ${titleA}`), String(replied.lastAnswer?.body.text));
});

await check("a reply to the delivered report reaches the report's chat", async () => {
  const toReport = await say("why this first?", deliveredMessage!.messageId);
  assert.deepEqual(toReport.ranIn, [chatB]);
});

await check("a reply to a message nobody recorded stays where the conversation is", async () => {
  const unknown = await say("hm", 99999);
  assert.deepEqual(unknown.ranIn, [chatB]);
});

await check("a reply into a chat that was deleted stays where the conversation is", async () => {
  const doomed = "dddddddd-0000-4000-8000-000000000004";
  await createChat(doomed, "Gone soon");
  await conversation.recordTelegramMessages({
    botKey: conversation.telegramBotKey(BOT_TOKEN),
    telegramChatId: 42,
    messageIds: [7777],
    chatId: doomed,
  });
  await deleteChat(doomed);
  const stale = await say("still there?", 7777);
  assert.deepEqual(stale.ranIn, [chatB]);
});

console.log("\nThe chat list a messenger does not have\n");

const listed = await say("/chats");
await check("/chats answers without running the model", () => {
  assert.equal(listed.ranIn.length, 0);
});

await check("/chats lists the chats, each with the command that opens it", () => {
  const text = String(listed.lastAnswer?.body.text || "");
  assert.ok(text.includes(`/c_${chatShortId(chatA)}`), text);
  assert.ok(text.includes(`/c_${chatShortId(chatB)}`), text);
  assert.ok(text.includes("Morning review · Oct 1"), text);
});

await check("no \"Thinking…\" draft flickers for an instant command", () => {
  assert.equal(listed.drafts, 0);
  assert.ok(plain.drafts > 0, "an ordinary turn should still draft");
});

const opened = await say(`/c_${chatShortId(chatA)}`);
await check("/c_<id> moves the conversation to that chat without running the model", async () => {
  assert.equal(opened.ranIn.length, 0);
  assert.equal(await sessionChat(), chatA);
  assert.match(String(opened.lastAnswer?.body.text || ""), /Now in/);
});

await check("an id that matches nothing is said so, and nothing moves", async () => {
  const missing = await say("/c_ffffffff");
  assert.match(String(missing.lastAnswer?.body.text || ""), /No chat matches/);
  assert.equal(await sessionChat(), chatA);
});

console.log("\nThe agent moving the conversation\n");

await check("a switch the agent makes holds from the next message, in the target's project", async () => {
  holder.__eggentTestRunner = {
    reply: "Switched to the morning review.",
    toolResult: { toolName: "eggent_manage_chats", payload: { success: true, action: "switch_chat", chatId: chatB } },
  };
  const moved = await say("go back to the morning review");
  holder.__eggentTestRunner = {};
  assert.deepEqual(moved.ranIn, [chatA], "the turn itself runs where the request was made");
  const session = await getExternalSession(SESSION_ID);
  assert.equal(session?.activeChatId, chatB);
  assert.equal(session?.activeProjectId, project.id);
  assert.match(String(moved.lastAnswer?.body.text || ""), /💬 Morning review · Oct 1/);
  const after = await say("ok, continue");
  assert.deepEqual(after.ranIn, [chatB]);
});

await check("a reply to the switch message continues where it pointed", async () => {
  const lastSwitch = sent.filter((entry) => entry.method === "sendMessage" && String(entry.body.text || "").includes("Switched to the morning review."));
  const target = lastSwitch[lastSwitch.length - 1];
  assert.ok(target);
  const back = await conversation.chatForTelegramMessage({
    botKey: conversation.telegramBotKey(BOT_TOKEN),
    telegramChatId: 42,
    messageId: target.messageId,
  });
  assert.equal(back, chatB);
});

console.log("\nThrough the deployment's bot\n");

await check("a reply arriving through the external API reaches the replied-to chat", async () => {
  const relaySession = "cloud-telegram:77";
  await conversation.recordTelegramMessages({
    botKey: conversation.RELAY_BOT_KEY,
    telegramChatId: 77,
    messageIds: [12],
    chatId: chatB,
  });
  const runsBefore = holder.__eggentTestRuns?.length ?? 0;
  const result = await handleExternalMessage({
    sessionId: relaySession,
    message: "what about the second item?",
    toolRuntimeData: { telegram: { chatId: 77, replyToMessageId: 13 } },
    telegramReplyToMessageId: 12,
  });
  assert.deepEqual(holder.__eggentTestRuns?.slice(runsBefore), [chatB]);
  assert.equal(result.context.activeChatId, chatB);
  assert.equal(result.context.activeChatTitle, "Morning review · Oct 1");
  assert.equal((await getExternalSession(relaySession))?.activeChatId, chatB);
});

await check("the same message id from another bot is a different message", async () => {
  const other = await conversation.chatForTelegramMessage({ botKey: conversation.RELAY_BOT_KEY, telegramChatId: 42, messageId: first.lastAnswer.messageId });
  assert.equal(other, null);
});

console.log("\nThe record itself\n");

await check("many writes at once lose nothing", async () => {
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      conversation.recordTelegramMessages({ botKey: "bot:test", telegramChatId: 5, messageIds: [index + 1], chatId: chatA })
    )
  );
  for (let index = 1; index <= 25; index += 1) {
    assert.equal(
      await conversation.chatForTelegramMessage({ botKey: "bot:test", telegramChatId: 5, messageId: index }),
      chatA,
      `message ${index} was lost`
    );
  }
});

await check("the oldest entries give way once the record is full", async () => {
  await conversation.recordTelegramMessages({ botKey: "bot:old", telegramChatId: 9, messageIds: [1], chatId: chatA });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await conversation.recordTelegramMessages({
    botKey: "bot:bulk",
    telegramChatId: 9,
    messageIds: Array.from({ length: 3000 }, (_, index) => index + 1),
    chatId: chatA,
  });
  assert.equal(await conversation.chatForTelegramMessage({ botKey: "bot:old", telegramChatId: 9, messageId: 1 }), null);
  assert.equal(await conversation.chatForTelegramMessage({ botKey: "bot:bulk", telegramChatId: 9, messageId: 3000 }), chatA);
});

globalThis.fetch = realFetch;
process.chdir(os.tmpdir());
fs.rmSync(workdir, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
