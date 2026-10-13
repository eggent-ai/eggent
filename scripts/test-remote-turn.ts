/**
 * A chat that runs on the other side of a paired workspace and computer.
 *
 * Drives the real routes in two real processes - a workspace ("cloud") and a
 * computer ("device") - joined by a stand-in control plane and a deliberately
 * slow stand-in for the file sync, with a stub model that says which side asked
 * it. What is checked is what the person is left with: the answer streams in
 * the place they typed, it was produced in the place the chat lives, the chat
 * and the agent's memory of it are whole afterwards on both sides, and every
 * way it can go wrong says so instead of hanging.
 *
 * Run with Node 22:  npm run test:remote-turn
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  readChatFile,
  readChatStream,
  sessionFilesOf,
  sleep,
  startModel,
  startRelay,
  startSide,
  startSyncer,
  type Side,
} from "./lib/remote-test-kit.ts";

process.env.EGGENT_AUTH_SECRET = "remote-test-secret-0123456789abcdef";
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const session = await createSessionToken("owner@example.test", false);
const cookie = `${AUTH_COOKIE_NAME}=${session}`;
const repoRoot = path.resolve(import.meta.dirname, "..");

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

const model = await startModel();
let cloud: Side;
let device: Side;
const relay = await startRelay({ cloud: () => cloud, device: () => device }, session);
const syncDelayMs = 700;

cloud = await startSide({ name: "cloud", node: "cloud", relayUrl: relay.url("cloud"), modelUrl: model.url, repoRoot });
device = await startSide({ name: "device", node: "device:test-mac", relayUrl: relay.url("device"), modelUrl: model.url, repoRoot });
const syncer = startSyncer(cloud.root, device.root, { delayMs: syncDelayMs });

const JSON_HEADERS = { "content-type": "application/json", cookie };

function post(side: Side, route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${side.url}${route}`, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
}
function get(side: Side, route: string): Promise<Response> {
  return fetch(`${side.url}${route}`, { headers: { cookie } });
}

async function until(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const messagesOf = (side: Side, chatId: string) => readChatFile(side.root, chatId)?.messages ?? [];

try {
  // ------------------------------------------------------------------ 1
  const chat1 = crypto.randomUUID();
  let firstDoneAt = 0;
  await check("a new chat started on the computer with the cloud as its home runs in the cloud and streams back", async () => {
    const started = Date.now();
    const response = await post(device, "/api/chat", { chatId: chat1, message: "hello one", home: "cloud", projectId: "none" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-chat-id"), chat1);
    const read = await readChatStream(response);
    firstDoneAt = read.finishedAt;
    assert.match(read.text, /cloud answered\./, `answer was produced somewhere else: ${read.text}`);
    assert.match(read.text, /ctx users=1/);
    assert.equal(model.callsBy("device").length, 0, "the computer's own model was asked");
    assert.equal(model.callsBy("cloud").length, 1);
    // The computer did not write the conversation: the cloud did.
    assert.ok(read.finishedAt - started >= syncDelayMs, "the screen was let go before the chat could have arrived");
  });

  await check("the stream is not let go until the chat has reached the computer", () => {
    const onDevice = messagesOf(device, chat1);
    assert.equal(onDevice.length >= 2, true, `device holds ${onDevice.length} messages`);
    assert.equal(onDevice[0].role, "user");
    assert.equal(onDevice[0].content, "hello one");
    assert.equal(onDevice[onDevice.length - 1].role, "assistant");
    assert.ok(firstDoneAt > 0);
  });

  await check("the chat remembers where it lives, on both sides", () => {
    assert.equal(readChatFile(cloud.root, chat1)?.home, "cloud");
    assert.equal(readChatFile(device.root, chat1)?.home, "cloud");
  });

  await check("the agent's own record of the conversation is the cloud's, and reaches the computer", async () => {
    assert.equal(sessionFilesOf(cloud.root, chat1).length, 1);
    await until("the agent's record on the computer", () => sessionFilesOf(device.root, chat1).length === 1);
  });

  await check("the cloud was told it is running a turn handed over from a computer", () => {
    const call = model.callsBy("cloud")[0];
    assert.match(call.system, /Where this chat runs/);
    assert.match(call.system, /handed over from their computer/);
  });

  // ------------------------------------------------------------------ 2
  await check("a second message continues the same conversation, still in the cloud", async () => {
    const response = await post(device, "/api/chat", { chatId: chat1, message: "hello two", projectId: "none" });
    const read = await readChatStream(response);
    assert.match(read.text, /cloud answered\./);
    assert.match(read.text, /ctx users=2/, `the agent did not see the first exchange: ${read.text}`);
    assert.equal(messagesOf(device, chat1).filter((message) => message.role === "user").length, 2);
  });

  // ------------------------------------------------------------------ 3
  await check("switching the chat to the computer from the workspace, the next message runs there with the whole conversation", async () => {
    const flip = await post(cloud, "/api/chat/home", { chatId: chat1, home: "device:test-mac" });
    assert.equal(flip.status, 200, await flip.clone().text());
    assert.equal(readChatFile(cloud.root, chat1)?.home, "device:test-mac");

    const response = await post(cloud, "/api/chat", { chatId: chat1, message: "hello three", projectId: "none" });
    assert.equal(response.status, 200, await response.clone().text());
    const read = await readChatStream(response);
    assert.match(read.text, /device answered\./, `answer was produced somewhere else: ${read.text}`);
    assert.match(read.text, /ctx users=3/, `the computer did not see the earlier exchanges: ${read.text}`);
    assert.equal(model.callsBy("device").length, 1);
    assert.match(model.callsBy("device")[0].system, /handed over from their cloud workspace and runs on the person's own computer/);
    // The turn is written by the computer and comes back to the workspace.
    assert.equal(messagesOf(cloud, chat1).filter((message) => message.role === "user").length, 3);
    assert.equal(readChatFile(device.root, chat1)?.home, "device:test-mac");
  });

  // ------------------------------------------------------------------ 4
  const chat4 = crypto.randomUUID();
  await check("a chat the computer has not received yet is refused with a reason, and nothing is written", async () => {
    const first = await readChatStream(await post(cloud, "/api/chat", { chatId: chat4, message: "local cloud one" }));
    assert.match(first.text, /cloud answered\./);
    syncer.pause();
    const flip = await post(cloud, "/api/chat/home", { chatId: chat4, home: "device:test-mac" });
    assert.equal(flip.status, 200);
    const deviceCalls = model.callsBy("device").length;
    const refused = await post(cloud, "/api/chat", { chatId: chat4, message: "to the computer" });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { code?: string; error?: string };
    assert.equal(body.code, "not-synced");
    assert.match(body.error ?? "", /hasn't received this chat's latest changes/);
    assert.equal(model.callsBy("device").length, deviceCalls, "the computer's model was asked anyway");
    assert.equal(messagesOf(cloud, chat4).filter((message) => message.role === "user").length, 1, "the refused message was written down");
    syncer.resume();
  });

  await check("the same message goes through once the files have arrived, and the computer knows everything said before", async () => {
    const read = await readChatStream(await post(cloud, "/api/chat", { chatId: chat4, message: "to the computer, again" }));
    assert.match(read.text, /device answered\./, read.text);
    assert.match(read.text, /ctx users=2/, read.text);
  });

  const chat4b = crypto.randomUUID();
  await check("the other way: a chat that started on the computer is not handed to the cloud before the cloud has it", async () => {
    const first = await readChatStream(await post(device, "/api/chat", { chatId: chat4b, message: "local device one" }));
    assert.match(first.text, /device answered\./);
    syncer.pause();
    assert.equal((await post(device, "/api/chat/home", { chatId: chat4b, home: "cloud" })).status, 200);
    const cloudCalls = model.callsBy("cloud").length;
    const refused = await post(device, "/api/chat", { chatId: chat4b, message: "to the cloud" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code?: string }).code, "not-synced");
    assert.equal(model.callsBy("cloud").length, cloudCalls);
    syncer.resume();
    const read = await readChatStream(await post(device, "/api/chat", { chatId: chat4b, message: "to the cloud, again" }));
    assert.match(read.text, /cloud answered\./, read.text);
    assert.match(read.text, /ctx users=2/, read.text);
  });

  // ------------------------------------------------------------------ 5
  await check("a computer that is not there is said to be missing, before anything is sent or written", async () => {
    relay.state.deviceOnline = false;
    try {
      const status = (await (await get(cloud, "/api/remote/status")).json()) as { enabled: boolean; node: string; devices: Array<{ online: boolean }> };
      assert.equal(status.enabled, true);
      assert.equal(status.node, "cloud");
      assert.equal(status.devices[0].online, false);

      const before = messagesOf(cloud, chat1).length;
      const response = await post(cloud, "/api/chat", { chatId: chat1, message: "anyone there?" });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { code?: string; error?: string };
      assert.equal(body.code, "offline");
      assert.match(body.error ?? "", /Test Mac|your computer/i);
      assert.equal(messagesOf(cloud, chat1).length, before);

      const flip = await post(cloud, "/api/chat/home", { chatId: chat1, home: "device:test-mac" });
      assert.equal(flip.status, 409);
      assert.equal(((await flip.json()) as { code?: string }).code, "offline");
    } finally {
      relay.state.deviceOnline = true;
    }
  });

  await check("a computer whose history is not shared cannot be chosen", async () => {
    relay.state.historyShared = false;
    try {
      const chat = crypto.randomUUID();
      await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "plain cloud chat" }));
      const flip = await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" });
      assert.equal(flip.status, 409);
      assert.equal(((await flip.json()) as { code?: string }).code, "not-ready");
    } finally {
      relay.state.historyShared = true;
    }
  });

  await check("a computer can only hand a chat to the cloud, never to another computer", async () => {
    const response = await post(device, "/api/chat/home", { chatId: chat1, home: "device:another" });
    assert.equal(response.status, 400);
  });

  // ------------------------------------------------------------------ 6
  const chat6 = crypto.randomUUID();
  await check("stopping a chat that runs on the other side stops it there and keeps what it had said", async () => {
    const pending = post(device, "/api/chat", { chatId: chat6, message: "SLOW stop me", home: "cloud", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(1100);
    const stop = await post(device, `/api/chat/${chat6}/stop`, {});
    assert.equal(((await stop.json()) as { stopped?: boolean }).stopped, true);
    const read = await pending;
    assert.ok(read.text.includes("slow0"), `nothing arrived before the stop: ${read.text}`);
    assert.ok(!read.text.includes("slow15"), `the turn ran to the end: ${read.text}`);
    await until("the partial answer on the cloud", () => messagesOf(cloud, chat6).some((message) => message.role === "assistant"));
    const stored = messagesOf(cloud, chat6).filter((message) => message.role === "assistant").map((message) => message.content).join("");
    assert.ok(stored.includes("slow0") && !stored.includes("slow15"), `stored: ${stored}`);
    await until("the partial answer on the computer", () => messagesOf(device, chat6).some((message) => message.role === "assistant"));
    // Both sides are free again.
    const activeCloud = (await (await get(cloud, "/api/chat/active-runs")).json()) as { runs: unknown[] };
    const activeDevice = (await (await get(device, "/api/chat/active-runs")).json()) as { runs: unknown[] };
    assert.equal(activeCloud.runs.length, 0);
    assert.equal(activeDevice.runs.length, 0);
  });

  await check("a stop word typed as a message is passed over too", async () => {
    const chat = crypto.randomUUID();
    const pending = post(device, "/api/chat", { chatId: chat, message: "SLOW then stop word", home: "cloud", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(1100);
    const stopWord = await readChatStream(await post(device, "/api/chat", { chatId: chat, message: "stop" }));
    assert.match(stopWord.text, /Stopped/);
    const read = await pending;
    assert.ok(!read.text.includes("slow15"), read.text);
  });

  // ------------------------------------------------------------------ 7
  const chat7 = crypto.randomUUID();
  await check("a message sent while the other side is working joins that turn, before the files of the chat have even arrived", async () => {
    const pending = post(device, "/api/chat", { chatId: chat7, message: "SLOW steer me", home: "cloud", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(400);
    // The chat's file has not reached this side yet: the id alone must be enough to know where it lives.
    assert.equal(readChatFile(device.root, chat7), null);
    const callsBefore = model.callsBy("cloud").length;
    const steer = await readChatStream(await post(device, "/api/chat", { chatId: chat7, message: "also mention the weather" }));
    assert.match(steer.text, /taking that into account/);
    const read = await pending;
    assert.ok(read.text.includes("slow15") || read.text.length > 0);
    await until("the steered message to reach the model", () => model.callsBy("cloud").slice(callsBefore).some((call) => call.userTexts.join(" ").includes("also mention the weather")));
    assert.equal(model.callsBy("device").filter((call) => call.userTexts.join(" ").includes("also mention the weather")).length, 0, "the computer ran the steered message itself");
    assert.equal(readChatFile(device.root, chat7)?.home ?? "cloud", "cloud");
  });

  // ------------------------------------------------------------------ 8
  const chat8 = crypto.randomUUID();
  await check("a connection that drops mid-answer ends the stream with an explanation, and the turn finishes where it runs", async () => {
    relay.state.cutStreamOf = "/api/chat";
    const response = await post(device, "/api/chat", { chatId: chat8, message: "SLOW lose the line", home: "cloud", projectId: "none" });
    const read = await readChatStream(response);
    const errors = read.chunks.filter((part) => part.type === "error").map((part) => String(part.errorText));
    assert.ok(errors.some((text) => /was lost/.test(text)), `no explanation: ${JSON.stringify(read.chunks.slice(-3))}`);
    assert.equal(read.done, true, "the stream never closed");
    // The turn belongs to the chat, not to the connection.
    await until("the full answer to be stored in the cloud", () => messagesOf(cloud, chat8).some((message) => message.role === "assistant" && message.content.includes("slow15")), 20_000);
    await until("the full answer to reach the computer", () => messagesOf(device, chat8).some((message) => message.role === "assistant" && message.content.includes("slow15")), 20_000);
  });

  // ------------------------------------------------------------------ 9
  await check("a question the agent asks over there is answered here, and the turn goes on", async () => {
    const chat = crypto.randomUUID();
    let questionAnswered = false;
    const read = await readChatStream(
      await post(device, "/api/chat", { chatId: chat, message: "ASK-ME please", home: "cloud", projectId: "none" }),
      (part) => {
        if (part.type !== "data-piInteraction" || questionAnswered) return;
        const interaction = part.data as { id: string; runId: string; status: string };
        if (interaction.status !== "pending") return;
        questionAnswered = true;
        void post(device, `/api/pi-runs/${encodeURIComponent(interaction.runId)}/interactions/${encodeURIComponent(interaction.id)}/respond`, { value: "blue" });
      }
    );
    assert.equal(questionAnswered, true, "the card never arrived");
    assert.match(read.text, /cloud got the answer/, read.text);
    assert.match(read.text, /blue/, read.text);
  });

  // ------------------------------------------------------------------ 10
  await check("a handed-over turn is never handed on, whatever the chat's copy says", async () => {
    const chat = crypto.randomUUID();
    // The cloud's copy of this chat says it lives on the computer - exactly the loop a stale file could make.
    fs.mkdirSync(path.join(cloud.root, "data", "chats"), { recursive: true });
    fs.writeFileSync(path.join(cloud.root, "data", "chats", `${chat}.json`), JSON.stringify({
      id: chat, title: "Loop", home: "device:test-mac", messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const deviceCallsBefore = model.callsBy("device").length;
    const response = await post(cloud, "/api/chat", { chatId: chat, message: "ran where it landed", projectId: "none" }, {
      "x-eggent-relayed": "1",
      "x-eggent-from": "device:test-mac",
    });
    const read = await readChatStream(response);
    assert.match(read.text, /cloud answered\./, read.text);
    assert.equal(model.callsBy("device").length, deviceCallsBefore);
    await until("the chat to say it lives here now", () => readChatFile(cloud.root, chat)?.home === "cloud");
  });

  await check("a handed-over request that names no side, or this very side, is refused", async () => {
    const noSide = await post(cloud, "/api/chat", { chatId: crypto.randomUUID(), message: "x" }, { "x-eggent-relayed": "1" });
    assert.equal(noSide.status, 400);
    const self = await post(cloud, "/api/chat", { chatId: crypto.randomUUID(), message: "x" }, { "x-eggent-relayed": "1", "x-eggent-from": "cloud" });
    assert.equal(self.status, 400);
  });

  // ------------------------------------------------------------------ 11
  await check("the chat cannot be switched while it is working", async () => {
    const chat = crypto.randomUUID();
    const pending = post(device, "/api/chat", { chatId: chat, message: "SLOW busy", home: "cloud", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(900);
    const flip = await post(device, "/api/chat/home", { chatId: chat, home: null });
    assert.equal(flip.status, 409);
    assert.equal(((await flip.json()) as { code?: string }).code, "busy");
    await pending;
  });

  await check("a switch for a chat that does not exist yet is accepted, and stored nowhere", async () => {
    const response = await post(device, "/api/chat/home", { chatId: crypto.randomUUID(), home: "cloud" });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { stored?: boolean }).stored, false);
  });

  await check("the switch routes need a session", async () => {
    const response = await fetch(`${device.url}/api/chat/home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ home: "cloud" }) });
    assert.equal(response.status, 401);
    const head = await fetch(`${device.url}/api/chat/${chat1}/head`);
    assert.equal(head.status, 401);
    const foreign = await fetch(`${device.url}/api/chat/home`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://elsewhere.example.test", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ home: "cloud" }),
    });
    assert.equal(foreign.status, 403);
  });

  await check("a chat's head says where it ends", async () => {
    const response = await get(cloud, `/api/chat/${chat1}/head`);
    const head = (await response.json()) as { messages: number; lastMessageId: string; sessionLeaf: string; running: boolean };
    const stored = messagesOf(cloud, chat1);
    assert.equal(head.messages, stored.length);
    assert.equal(head.lastMessageId, stored[stored.length - 1].id);
    assert.match(head.sessionLeaf, /^[0-9a-f]{8}$/);
    assert.equal(head.running, false);
  });

  // ------------------------------------------------------------------ 12
  await check("an install with nothing set up ignores a stored home and runs the chat where it is typed", async () => {
    const plain = await startSide({ name: "plain", node: "", relayUrl: "", modelUrl: model.url, repoRoot });
    try {
      const chat = crypto.randomUUID();
      fs.mkdirSync(path.join(plain.root, "data", "chats"), { recursive: true });
      fs.writeFileSync(path.join(plain.root, "data", "chats", `${chat}.json`), JSON.stringify({
        id: chat, title: "Stored home", home: "cloud", messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));
      const read = await readChatStream(await post(plain, "/api/chat", { chatId: chat, message: "stay home", projectId: "none" }));
      assert.match(read.text, /plain answered\./, read.text);
      const status = (await (await get(plain, "/api/remote/status")).json()) as { enabled: boolean };
      assert.equal(status.enabled, false);
      const flip = await post(plain, "/api/chat/home", { chatId: chat, home: "cloud" });
      assert.equal(flip.status, 404);
    } finally {
      await plain.stop();
      fs.rmSync(plain.root, { recursive: true, force: true });
    }
  });

  await check("a turn that stays on its own side is untouched: no handover, no remote line in the prompt", async () => {
    const chat = crypto.randomUUID();
    const carriedBefore = relay.state.carried.length;
    const read = await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "just here" }));
    assert.match(read.text, /cloud answered\./);
    assert.equal(relay.state.carried.length, carriedBefore);
    const call = model.callsBy("cloud").at(-1)!;
    assert.ok(!/Where this chat runs/.test(call.system));
  });
} finally {
  syncer.stop();
  await cloud.stop();
  await device.stop();
  await relay.close();
  await model.close();
}

console.log(`\n${ran - failed}/${ran} passed`);
for (const side of [cloud, device]) {
  if (failed > 0) console.log(`--- ${side.name} log ---\n${side.log.join("").slice(-3000)}`);
}
fs.rmSync(cloud.root, { recursive: true, force: true });
fs.rmSync(device.root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
