/**
 * A bot is connected by webhook where the deployment says so, and a webhook is
 * answered before the turn it starts.
 *
 * Run with Node 22: npm run test:telegram-webhook
 *
 * A bot that polls keeps its workspace running for ever: nothing outside would
 * wake it for the next message. Every bot connected in the cloud was polling,
 * because the screen and the agent's tool both asked for polling by name, so
 * those workspaces never slept. And a webhook used to hold Telegram's request
 * open for the whole turn, which Telegram gives up on and delivers again.
 *
 * The handler runs for real in a throwaway working directory; the turn is the
 * stub in scripts/stubs/handle-external-message.ts, and Telegram's API and the
 * claim endpoint are stubs that record what was asked of them.
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

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-telegram-webhook-"));
process.chdir(workdir);
process.env.PI_CODING_AGENT_DIR = path.join(workdir, "data", "pi-agent");
delete process.env.TELEGRAM_MODE;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.APP_BASE_URL;
process.env.EGGENT_CLOUD_TELEGRAM_CLAIM_URL = "http://claim.example.test/api/internal/telegram/claim";
process.env.EGGENT_CLOUD_INSTANCE_ID = "test-ws";
process.env.EXTERNAL_API_TOKEN = "test-external-token";

type Call = { url: string; method: string; body: Record<string, unknown> };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isTelegram = url.startsWith("https://api.telegram.org/");
  const isClaim = url.startsWith("http://claim.example.test/");
  if (!isTelegram && !isClaim) return realFetch(input, init);
  let body: Record<string, unknown> = {};
  try {
    body = init?.body ? JSON.parse(String(init.body)) : {};
  } catch {
    body = {};
  }
  const method = url.split("/").pop() || "";
  calls.push({ url, method, body });
  if (method === "getMe") {
    return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "test_bot" } });
  }
  if (method === "getUpdates") {
    return Response.json({ ok: true, result: [] });
  }
  if (isClaim) return Response.json({ success: true, disconnectedCount: 0 });
  return Response.json({ ok: true, result: { message_id: calls.length } });
}) as typeof fetch;

const t = ((key: string) => key) as never;
const { connectTelegramBot, defaultTelegramSetupMode } = await import("../src/lib/telegram/setup.ts");
const { getTelegramIntegrationStoredSettings, saveTelegramIntegrationStoredSettings } = await import(
  "../src/lib/storage/telegram-integration-store.ts"
);
const { telegramPollingService } = await import("../src/lib/telegram/polling-service.ts");
const { enqueueTelegramWebhookUpdate, isTextOnlyUpdate, WEBHOOK_UPDATE_ATTEMPTS } = await import(
  "../src/lib/telegram/webhook-queue.ts"
);

const BOT_TOKEN = "123456789:AAtest-token-for-a-local-test-only-00000";
const PUBLIC = "https://ws.example.test";

console.log("Which way a bot is connected when nobody says\n");

await check("without TELEGRAM_MODE it is polling, as it always was", () => {
  delete process.env.TELEGRAM_MODE;
  assert.equal(defaultTelegramSetupMode(PUBLIC), "polling");
});

await check("a deployment that says webhook, with a public address, gets webhook", () => {
  process.env.TELEGRAM_MODE = "webhook";
  assert.equal(defaultTelegramSetupMode(PUBLIC), "webhook");
});

await check("but not where Telegram cannot reach the address", () => {
  process.env.TELEGRAM_MODE = "webhook";
  assert.equal(defaultTelegramSetupMode(""), "polling");
  assert.equal(defaultTelegramSetupMode("http://localhost:3000"), "polling");
  assert.equal(defaultTelegramSetupMode("https://192.168.1.10"), "polling");
  assert.equal(defaultTelegramSetupMode("http://ws.example.test"), "polling");
});

await check("connecting with no mode on such a deployment sets a webhook and does not poll", async () => {
  process.env.TELEGRAM_MODE = "webhook";
  calls.length = 0;
  const result = await connectTelegramBot({ botToken: BOT_TOKEN, fallbackPublicBaseUrl: PUBLIC, t });
  assert.equal(result.mode, "webhook");
  assert.equal(result.webhookUrl, `${PUBLIC}/api/integrations/telegram`);
  const setWebhook = calls.find((call) => call.method === "setWebhook");
  assert.ok(setWebhook, "setWebhook was not called");
  assert.equal(setWebhook!.body.url, `${PUBLIC}/api/integrations/telegram`);
  assert.ok(String(setWebhook!.body.secret_token || "").length > 10, "no secret given to Telegram");
  assert.ok(!calls.some((call) => call.method === "deleteWebhook"), "the webhook was deleted");
  assert.equal(telegramPollingService.status.isRunning, false);
  const stored = await getTelegramIntegrationStoredSettings();
  assert.equal(stored.mode, "webhook");
});

await check("a webhook bot is claimed too, so a copy of the token elsewhere lets go of it", () => {
  const claim = calls.find((call) => call.url.startsWith("http://claim.example.test/"));
  assert.ok(claim, "no claim was made");
  assert.equal(claim!.body.instanceId, "test-ws");
});

await check("asking for polling by name is still polling", async () => {
  calls.length = 0;
  const result = await connectTelegramBot({ botToken: BOT_TOKEN, mode: "polling", fallbackPublicBaseUrl: PUBLIC, t });
  assert.equal(result.mode, "polling");
  assert.ok(calls.some((call) => call.method === "deleteWebhook"), "the webhook was left in place");
  assert.equal(telegramPollingService.status.isRunning, true);
});

await check("switching that bot to webhook stops its polling", async () => {
  calls.length = 0;
  const result = await connectTelegramBot({ mode: "webhook", fallbackPublicBaseUrl: PUBLIC, t });
  assert.equal(result.mode, "webhook");
  assert.equal(telegramPollingService.status.isRunning, false);
});

console.log("\nThe webhook route answers before the turn ends\n");

const SECRET = "test-webhook-secret-0123456789";
process.env.TELEGRAM_MODE = "webhook";
await saveTelegramIntegrationStoredSettings({
  botToken: BOT_TOKEN,
  webhookSecret: SECRET,
  publicBaseUrl: PUBLIC,
  mode: "webhook",
  allowedUserIds: ["42"],
} as never);
const route = await import("../src/app/api/integrations/telegram/route.ts");

let nextUpdateId = 5000;
function textUpdate(text: string, chat = 42) {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: { message_id: nextUpdateId, date: 0, chat: { id: chat, type: "private" }, from: { id: 42, is_bot: false, first_name: "Test" }, text },
  };
}
function post(body: unknown, secret = SECRET) {
  return new Request(`${PUBLIC}/api/integrations/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });
}
function setTurn(turn: Record<string, unknown>) {
  (globalThis as { __eggentTestTurn?: unknown }).__eggentTestTurn = turn;
}

await check("a wrong secret is refused and nothing runs", async () => {
  const response = await route.POST(post(textUpdate("hi"), "wrong") as never);
  assert.equal(response.status, 401);
});

await check("an update with no id is refused", async () => {
  const response = await route.POST(post({ message: { text: "hi" } }) as never);
  assert.equal(response.status, 400);
});

await check("Telegram gets its answer while the turn is still running, and the reply follows", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setTurn({ reply: "Answer after the gate.", gate });
  calls.length = 0;
  const started = Date.now();
  const response = await route.POST(post(textUpdate("long task")) as never);
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 1000, "the route waited for the turn");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.accepted, true);
  assert.ok(!calls.some((call) => call.method === "sendMessage" && /Answer after the gate/.test(String(call.body.text))));
  release();
  for (let i = 0; i < 100 && !calls.some((call) => call.method === "sendMessage" && /Answer after the gate/.test(String(call.body.text))); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    calls.some((call) => call.method === "sendMessage" && /Answer after the gate/.test(String(call.body.text))),
    "the reply was never sent"
  );
});

console.log("\nOne chat's updates, in order\n");

const runtime = {} as never;
function media(chat = 1) {
  nextUpdateId += 1;
  return { update_id: nextUpdateId, message: { chat: { id: chat }, voice: { file_id: "v" } } } as never;
}
function text(value: string, chat = 1) {
  nextUpdateId += 1;
  return { update_id: nextUpdateId, message: { chat: { id: chat }, text: value } } as never;
}

await check("only plain text counts as text-only", () => {
  assert.equal(isTextOnlyUpdate(text("hi")), true);
  assert.equal(isTextOnlyUpdate(media()), false);
  assert.equal(isTextOnlyUpdate({ update_id: 1, message: { chat: { id: 1 }, text: "look", photo: [{}] } } as never), false);
  assert.equal(isTextOnlyUpdate({ update_id: 1, message: { chat: { id: 1 }, text: "  " } } as never), false);
});

await check("a voice note sent while the chat is busy waits for the update before it", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const handle = async (update: { message?: { voice?: unknown; text?: string } }) => {
    const label = update.message?.voice ? "voice" : String(update.message?.text);
    order.push(`start ${label}`);
    if (label === "first") await first;
    order.push(`end ${label}`);
  };
  const a = enqueueTelegramWebhookUpdate(text("first", 7), runtime, handle as never);
  const b = enqueueTelegramWebhookUpdate(media(7), runtime, handle as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["start first"]);
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["start first", "end first", "start voice", "end voice"]);
});

await check("text sent while the chat is busy reaches the running turn at once", async () => {
  const order: string[] = [];
  let release!: () => void;
  const running = new Promise<void>((resolve) => (release = resolve));
  const handle = async (update: { message?: { voice?: unknown; text?: string } }) => {
    const label = update.message?.voice ? "voice" : String(update.message?.text);
    order.push(`start ${label}`);
    if (label === "voice") await running;
    order.push(`end ${label}`);
  };
  const a = enqueueTelegramWebhookUpdate(media(8), runtime, handle as never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const b = enqueueTelegramWebhookUpdate(text("stop", 8), runtime, handle as never);
  await b;
  assert.deepEqual(order, ["start voice", "start stop", "end stop"]);
  release();
  await a;
});

await check("another chat is not held up by a busy one", async () => {
  let release!: () => void;
  const running = new Promise<void>((resolve) => (release = resolve));
  const seen: string[] = [];
  const handle = async (update: { message?: { chat?: { id?: number } } }) => {
    seen.push(String(update.message?.chat?.id));
    if (update.message?.chat?.id === 9) await running;
  };
  const a = enqueueTelegramWebhookUpdate(media(9), runtime, handle as never);
  await enqueueTelegramWebhookUpdate(media(10), runtime, handle as never);
  assert.deepEqual(seen, ["9", "10"]);
  release();
  await a;
});

await check("an update that throws is tried again, then given up, and the next one still runs", async () => {
  let attempts = 0;
  const done: string[] = [];
  const handle = async (update: { message?: { text?: string } }) => {
    if (update.message?.text === "bad") {
      attempts += 1;
      throw new Error("Telegram could not be reached");
    }
    done.push(String(update.message?.text));
  };
  const bad = enqueueTelegramWebhookUpdate({ update_id: 1, message: { chat: { id: 12 }, text: "bad", voice: {} } } as never, runtime, handle as never, { retryDelayMs: 1 });
  const after = enqueueTelegramWebhookUpdate({ update_id: 2, message: { chat: { id: 12 }, text: "next", voice: {} } } as never, runtime, handle as never, { retryDelayMs: 1 });
  await Promise.all([bad, after]);
  assert.equal(attempts, WEBHOOK_UPDATE_ATTEMPTS);
  assert.deepEqual(done, ["next"]);
});

telegramPollingService.stop();
console.log(`\n${ran} checks, ${failed} failed`);
fs.rmSync(workdir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
