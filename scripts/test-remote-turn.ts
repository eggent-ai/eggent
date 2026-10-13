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
// For trying a change against the checks written for the review's findings alone (see mutate-core.py).
let inReviewSection = false;
const onlyReviewSection = process.env.EGGENT_TEST_ONLY_REVIEW === "1";
// A check that never comes back is a failure, not a hang: the thing most likely to go wrong in a
// handover is a turn waiting for an answer nobody can give.
const CHECK_TIMEOUT_MS = 100_000;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (onlyReviewSection && !inReviewSection) return;
  ran += 1;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
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

/** Another workspace and computer, set up differently, for the checks that need a setting the first pair does not have. */
async function startPair(name: string, env: Record<string, string>, delayMs: number) {
  let c: Side;
  let d: Side;
  const r = await startRelay({ cloud: () => c, device: () => d }, session);
  c = await startSide({ name: `${name}cloud`, node: "cloud", relayUrl: r.url("cloud"), modelUrl: model.url, repoRoot, env });
  d = await startSide({ name: `${name}device`, node: "device:test-mac", relayUrl: r.url("device"), modelUrl: model.url, repoRoot, env });
  const s = startSyncer(c.root, d.root, { delayMs });
  return {
    cloud: c,
    device: d,
    relay: r,
    syncer: s,
    async stop() {
      s.stop();
      await c.stop();
      await d.stop();
      await r.close();
      fs.rmSync(c.root, { recursive: true, force: true });
      fs.rmSync(d.root, { recursive: true, force: true });
    },
  };
}

const spare: { pair: Awaited<ReturnType<typeof startPair>> | null } = { pair: null };

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
    // While it runs, the side that only relays it says so: quitting that side loses nothing.
    const relaying = ((await (await get(device, "/api/chat/active-runs")).json()) as { runs: Array<{ chatId: string; home?: string }> }).runs;
    assert.deepEqual(relaying.map((run) => [run.chatId, run.home]), [[chat6, "cloud"]]);
    const running = ((await (await get(cloud, "/api/chat/active-runs")).json()) as { runs: Array<{ chatId: string; home?: string }> }).runs;
    assert.deepEqual(running.map((run) => [run.chatId, run.home]), [[chat6, undefined]], "the side that runs it must not say it is relaying");
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
    // The id alone was enough: this side did not make a chat of its own out of a file that has not arrived.
    assert.equal(readChatFile(device.root, chat7), null, "this side wrote the chat itself");
    const read = await pending;
    assert.match(read.text, /slow15/, "the turn that was steered did not run to its end");
    await until("the steered message to reach the model", () => model.callsBy("cloud").slice(callsBefore).some((call) => call.userTexts.join(" ").includes("also mention the weather")));
    assert.equal(model.callsBy("device").filter((call) => call.userTexts.join(" ").includes("also mention the weather")).length, 0, "the computer ran the steered message itself");
    // Its file arrives with the sync, and says where the chat lives.
    await until("the chat's file on the computer", () => readChatFile(device.root, chat7) !== null);
    assert.equal(readChatFile(device.root, chat7)?.home, "cloud");
  });

  await check("a message for a turn that is already running is not held up by what its sender thinks the chat looks like", async () => {
    const chat = crypto.randomUUID();
    const running = post(cloud, "/api/chat", { chatId: chat, message: "SLOW a long one", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(900);
    // The sender's idea of the chat names a message this side has never had - as after a question was asked and its half-written answer replaced.
    const steer = await fetch(`${cloud.url}/api/chat`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-eggent-relayed": "1", "x-eggent-from": "device:test-mac" },
      body: JSON.stringify({ chatId: chat, message: "and the colour too", projectId: "none", expectHead: { messages: 9, lastMessageId: "never-existed", sessionLeaf: "deadbeef", files: [] } }),
    });
    const read = await readChatStream(steer);
    assert.equal(steer.status, 200, read.text);
    assert.match(read.text, /taking that into account/);
    await running;
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

  await check("a request over the relay can answer the questions of a turn that was handed over, and of no other", async () => {
    // A turn the person is running on this computer themselves, not one the cloud handed over.
    const chat = crypto.randomUUID();
    let relayedStatus = 0;
    let both: Promise<void> | null = null;
    let seen = false;
    const read = await readChatStream(
      await post(device, "/api/chat", { chatId: chat, message: "ASK-ME on my own", projectId: "none" }),
      (part) => {
        if (part.type !== "data-piInteraction" || seen) return;
        const interaction = part.data as { id: string; runId: string; status: string };
        if (interaction.status !== "pending") return;
        seen = true;
        const route = `/api/pi-runs/${encodeURIComponent(interaction.runId)}/interactions/${encodeURIComponent(interaction.id)}/respond`;
        both = (async () => {
          const refused = await post(device, route, { value: "red" }, { "x-eggent-relayed": "1", "x-eggent-from": "cloud" });
          relayedStatus = refused.status;
          // The person's own window still can.
          await post(device, route, { value: "blue" });
        })();
      }
    );
    await both;
    assert.equal(seen, true, "the card never arrived");
    assert.equal(relayedStatus, 404, "the other side answered a question of a turn it did not hand over");
    assert.match(read.text, /blue/, read.text);
    assert.doesNotMatch(read.text, /red/, read.text);
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

  // ------------------------------------------------------------------ 12b (attachments)
  await check("a file attached to a chat is waited for like the chat is, and the agent is told it is there", async () => {
    const chat = crypto.randomUUID();
    await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "plain cloud turn" }));
    // Everything so far reaches the computer; then the line goes quiet and a file is attached.
    await until("the chat on the computer", () => sessionFilesOf(device.root, chat).length === 1 && messagesOf(device, chat).length === 2);
    syncer.pause();
    fs.mkdirSync(path.join(cloud.root, "data", "chat-files", chat), { recursive: true });
    fs.writeFileSync(path.join(cloud.root, "data", "chat-files", chat, "note.txt"), "attached text");
    assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);

    const deviceCalls = model.callsBy("device").length;
    const refused = await post(cloud, "/api/chat", { chatId: chat, message: "read the attachment" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code?: string }).code, "not-synced");
    assert.equal(model.callsBy("device").length, deviceCalls, "the agent was let in without the file");

    syncer.resume();
    const read = await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "read the attachment, now" }));
    assert.match(read.text, /device answered\./, read.text);
    const system = model.callsBy("device").at(-1)!.system;
    assert.match(system, /note\.txt/, "the agent was not told about the attachment");
  });

  // ------------------------------------------------------------------ 13 (a messenger)
  const TELEGRAM = { telegram: { chatId: 4242, botToken: "123:fake" } };
  async function tell(side: Side, session: string, message: string): Promise<{ status: number; body: Record<string, any> }> {
    const response = await fetch(`${side.url}/api/external/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-external-token" },
      body: JSON.stringify({ sessionId: session, message, toolRuntimeData: TELEGRAM }),
      signal: AbortSignal.timeout(80_000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  let tgChat = "";
  await check("a messenger's chat that lives on the computer is run there, and the reply is what the computer's agent wrote", async () => {
    const first = await tell(cloud, "tg-a", "first from the messenger");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(String(first.body.reply), /cloud answered\./);
    tgChat = first.body.context.activeChatId as string;
    const flip = await post(cloud, "/api/chat/home", { chatId: tgChat, home: "device:test-mac" });
    assert.equal(flip.status, 200, await flip.clone().text());

    const deviceCalls = model.callsBy("device").length;
    const second = await tell(cloud, "tg-a", "second from the messenger");
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.match(String(second.body.reply), /device answered\./, String(second.body.reply));
    assert.match(String(second.body.reply), /ctx users=2/, "the computer did not see the earlier exchange");
    assert.equal(model.callsBy("device").length, deviceCalls + 1);
    assert.equal(second.body.context.activeChatId, tgChat, "the conversation moved");
    // The turn was written down by the computer and is here by the time the reply goes out.
    const stored = messagesOf(cloud, tgChat);
    assert.equal(stored.filter((message) => message.role === "user").length, 2);
    assert.ok(stored[stored.length - 1].content.includes("device answered"));
  });

  await check("a question the agent would ask is not put to anyone: nobody is looking at that screen", async () => {
    const started = Date.now();
    const answer = await tell(cloud, "tg-a", "ASK-ME about the colour");
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.match(String(answer.body.reply), /device got the answer/);
    assert.match(String(answer.body.reply), /No interactive UI/, String(answer.body.reply));
    assert.ok(Date.now() - started < 25_000, "the turn waited for an answer nobody could give");
  });

  await check("a messenger's turn streams its progress as it comes, and ends with the whole result", async () => {
    const response = await fetch(`${cloud.url}/api/external/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-external-token", accept: "text/event-stream" },
      body: JSON.stringify({ sessionId: "tg-a", message: "SLOW progress please", toolRuntimeData: TELEGRAM }),
    });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const { readSseData } = await import("../src/lib/remote/sse.ts");
    const events: Array<{ type: string; delta?: string; at: number }> = [];
    for await (const data of readSseData(response.body!)) {
      try {
        events.push({ ...(JSON.parse(data) as { type: string; delta?: string }), at: Date.now() });
      } catch {
        // not an event
      }
    }
    const pieces = events.filter((event) => event.type === "text");
    assert.ok(pieces.length >= 5, `only ${pieces.length} pieces of text`);
    assert.ok(pieces.at(-1)!.at - pieces[0].at >= 1000, "the text arrived all at once");
    assert.equal(events.at(-1)?.type, "done");
  });

  await check("a computer that is not there is said so to the person, with the way out", async () => {
    relay.state.deviceOnline = false;
    try {
      const answer = await tell(cloud, "tg-a", "anybody home?");
      assert.equal(answer.status, 500, JSON.stringify(answer.body));
      assert.match(String(answer.body.error), /isn't available|not available/i);
      assert.match(String(answer.body.error), /\/here/, "no way out was offered");
    } finally {
      relay.state.deviceOnline = true;
    }
  });

  await check("/here brings the chat to the side that is reading it, and the next message runs there", async () => {
    const done = await tell(cloud, "tg-a", "/here");
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(String(done.body.reply), /runs here now/);
    assert.equal(readChatFile(cloud.root, tgChat)?.home, "cloud");
    const again = await tell(cloud, "tg-a", "/here");
    assert.match(String(again.body.reply), /already runs here/);
    const next = await tell(cloud, "tg-a", "back in the cloud");
    assert.match(String(next.body.reply), /cloud answered\./);
  });

  await check("a message sent while the computer is working on a messenger's turn joins that turn, and 'stop' stops it there", async () => {
    assert.equal((await post(cloud, "/api/chat/home", { chatId: tgChat, home: "device:test-mac" })).status, 200);
    const callsBefore = model.callsBy("device").length;
    const slow = tell(cloud, "tg-a", "SLOW telegram turn");
    await sleep(1200);
    const steered = await tell(cloud, "tg-a", "also mention the weather");
    assert.match(String(steered.body.reply), /taking that into account/, JSON.stringify(steered.body));
    const stopped = await tell(cloud, "tg-a", "stop");
    assert.match(String(stopped.body.reply), /Stopped/, JSON.stringify(stopped.body));
    const result = await slow;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.stopped, true, "the stopped turn did not say so");
    assert.ok(!String(result.body.reply).includes("slow15"), "it ran to the end");
    assert.equal(model.callsBy("cloud").filter((call) => call.userTexts.join(" ").includes("SLOW telegram turn")).length, 0, "the cloud ran it");
    assert.ok(model.callsBy("device").length > callsBefore);
  });

  // ------------------------------------------------------------------ after the review
  inReviewSection = true;
  const stalledEnv = {
    EGGENT_TURN_WATCHDOG: "on",
    EGGENT_TURN_SILENCE_MODEL_SECONDS: "3",
    EGGENT_TURN_SILENCE_START_SECONDS: "3",
    EGGENT_TURN_SILENCE_SOFT_SECONDS: "2",
    EGGENT_TURN_WATCHDOG_TICK_MS: "300",
    EGGENT_REMOTE_SETTLE_WAIT_SECONDS: "25",
  };
  const pairB = async () => (spare.pair ??= await startPair("b", stalledEnv, 500));

  await check("a chat refused for a computer that is away runs here when the person asks for that, and the refusal is not remembered", async () => {
    const chat = crypto.randomUUID();
    relay.state.deviceOnline = false;
    try {
      const first = await post(cloud, "/api/chat", { chatId: chat, message: "hello, computer", home: "device:test-mac", projectId: "none" });
      assert.equal(first.status, 409);
      assert.equal(((await first.json()) as { code?: string }).code, "offline");
      // "Run it here instead": the same chat, with this side as its home.
      const here = await post(cloud, "/api/chat", { chatId: chat, message: "hello, computer", home: "cloud", projectId: "none" });
      assert.equal(here.status, 200, "the person asked to run it here and was handed to the computer again");
      assert.match((await readChatStream(here)).text, /cloud answered\./);
    } finally {
      relay.state.deviceOnline = true;
    }
    // With the computer back, it is still where the person put it.
    const next = await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "and again", home: "cloud", projectId: "none" }));
    assert.match(next.text, /cloud answered\./);
    assert.equal(readChatFile(cloud.root, chat)?.home, "cloud");
    // A refusal leaves nothing behind that sends the next message the same way.
    const refused = crypto.randomUUID();
    relay.state.deviceOnline = false;
    try {
      assert.equal((await post(cloud, "/api/chat", { chatId: refused, message: "to nobody", home: "device:test-mac", projectId: "none" })).status, 409);
    } finally {
      relay.state.deviceOnline = true;
    }
    const plain = await post(cloud, "/api/chat", { chatId: refused, message: "now without saying where", projectId: "none" });
    assert.equal(plain.status, 200, "a message that says nothing about where was handed to the computer on the strength of a refusal");
    assert.match((await readChatStream(plain)).text, /cloud answered\./);
  });

  await check("a request that names this side as the chat's home is run here, even though this side handed the chat over a moment ago", async () => {
    const chat = crypto.randomUUID();
    syncer.pause();
    try {
      // A new chat handed to the cloud from the computer; its file has not come back yet.
      const started = await readChatStream(await post(device, "/api/chat", { chatId: chat, message: "start it in the cloud", home: "cloud", projectId: "none" }));
      assert.match(started.text, /cloud answered\./);
      assert.equal(readChatFile(device.root, chat), null);
      const calls = model.callsBy("device").length;
      const here = await post(device, "/api/chat", { chatId: chat, message: "no - here", home: "device:test-mac", projectId: "none" });
      assert.equal(here.status, 200);
      assert.match((await readChatStream(here)).text, /device answered\./, "it was handed to the cloud again on the strength of the memory of the first message");
      assert.equal(model.callsBy("device").length, calls + 1);
    } finally {
      // Two sides started the same chat on purpose; nothing about it is for the sync to join.
      for (const side of [cloud, device]) {
        fs.rmSync(path.join(side.root, "data", "chats", `${chat}.json`), { force: true });
        for (const file of sessionFilesOf(side.root, chat)) fs.rmSync(path.join(side.root, "data", "pi-sessions", file), { force: true });
      }
      syncer.resume();
    }
  });

  await check("pressing stop while the other side is still getting ready stops the turn before it starts", async () => {
    const chat = crypto.randomUUID();
    await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "plain cloud turn" }));
    syncer.pause();
    try {
      assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
      const controller = new AbortController();
      const sending = fetch(`${cloud.url}/api/chat`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ chatId: chat, message: "SLOW do the dangerous thing", projectId: "none" }),
        signal: controller.signal,
      }).catch(() => null);
      await sleep(1500);
      // What the screen does: lets go of the request, and says so.
      controller.abort();
      const stop = await post(cloud, `/api/chat/${chat}/stop`, {});
      assert.equal(((await stop.json()) as { stopped?: boolean }).stopped, true, "there was nothing registered to stop");
      await sending;
    } finally {
      syncer.resume();
    }
    // Long enough for the chat to arrive and for the computer to start the turn, were it going to.
    await sleep(5000);
    assert.equal(model.callsBy("device").filter((call) => call.userTexts.join(" ").includes("dangerous")).length, 0, "the turn the person stopped ran on their computer anyway");
    const runs = (await (await get(device, "/api/chat/active-runs")).json()) as { runs: unknown[] };
    assert.equal(runs.runs.length, 0);
  });

  await check("a message meant for a turn that has just ended starts a turn of its own that someone is watching", async () => {
    const first = await tell(cloud, "tg-late", "first from the messenger");
    const chat = first.body.context.activeChatId as string;
    assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
    await until("the chat on the computer", () => messagesOf(device, chat).length >= 2);

    // The computer finishes its answer, but the end of the stream never reaches the cloud.
    relay.state.stallStreamOf = "/api/chat";
    void tell(cloud, "tg-late", "SLOW the first long request").catch(() => undefined);
    await sleep(7500);

    const before = model.callsBy("device").length;
    const late = await tell(cloud, "tg-late", "and also add the second thing");
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.doesNotMatch(String(late.body.reply), /taking that into account/, "told it was folded into a turn that was over");
    assert.match(String(late.body.reply), /device answered\./, "the message did not get an answer of its own");
    assert.equal(model.callsBy("device").length, before + 1);
  });

  await check("a chat is not moved from under a turn that is running on the other side", async () => {
    const chat = crypto.randomUUID();
    // The computer's own chat, with the computer as its home; the cloud has its file.
    await readChatStream(await post(device, "/api/chat", { chatId: chat, message: "first, on the computer", home: "device:test-mac", projectId: "none" }));
    await until("the chat on the cloud", () => messagesOf(cloud, chat).length === 2);
    const long = post(device, "/api/chat", { chatId: chat, message: "SLOW long job on the computer", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(1200);
    const onCloud = (await (await get(cloud, "/api/chat/active-runs")).json()) as { runs: unknown[] };
    assert.equal(onCloud.runs.length, 0, "the cloud can see the turn by itself, which is not what this is about");
    const flip = await post(cloud, "/api/chat/home", { chatId: chat, home: "cloud" });
    assert.equal(flip.status, 409, "the cloud took the chat from a turn that was running on the computer");
    assert.equal(((await flip.json()) as { code?: string }).code, "busy");
    assert.equal(readChatFile(cloud.root, chat)?.home, "device:test-mac");
    await long;
    // Once it is over, the same switch is fine.
    await until("the end of the turn on the cloud", () => messagesOf(cloud, chat).length === 4);
    assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "cloud" })).status, 200);
  });

  await check("/here does not bring a chat back to the messenger while a turn is working on it, here or over there", async () => {
    const created = await tell(cloud, "tg-busy", "first from the messenger");
    const chat = created.body.context.activeChatId as string;
    assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
    await until("the chat on the computer", () => messagesOf(device, chat).length >= 2);

    // A turn this side relays.
    const slow = tell(cloud, "tg-busy", "SLOW a job for the computer");
    await sleep(1500);
    const refusedHere = await tell(cloud, "tg-busy", "/here");
    assert.match(String(refusedHere.body.reply), /working right now/, JSON.stringify(refusedHere.body));
    assert.equal(readChatFile(cloud.root, chat)?.home, "device:test-mac");
    await slow;

    // A turn the person started on the computer itself, which this side knows nothing about.
    const onTheComputer = post(device, "/api/chat", { chatId: chat, message: "SLOW typed on the computer", projectId: "none" }).then((response) => readChatStream(response));
    await sleep(1500);
    const refusedAgain = await tell(cloud, "tg-busy", "/here");
    assert.match(String(refusedAgain.body.reply), /working right now/, JSON.stringify(refusedAgain.body));
    await onTheComputer;
    await until("the chat settled on the cloud", () => messagesOf(cloud, chat).length >= 6);
    const done = await tell(cloud, "tg-busy", "/here");
    assert.match(String(done.body.reply), /runs here now/, JSON.stringify(done.body));
  });

  await check("what a messenger's turn did is found from where the computer's copy began, not from this side's older one", async () => {
    const first = await tell(cloud, "tg-count", "first from the messenger");
    const chat = first.body.context.activeChatId as string;
    assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
    await until("the chat on the computer", () => messagesOf(device, chat).length >= 2);
    syncer.pause();
    try {
      // The person worked in this chat on the computer a moment ago, and one of those turns moved the agent to another project.
      const file = path.join(device.root, "data", "chats", `${chat}.json`);
      const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
      const at = new Date().toISOString();
      stored.messages.push(
        { id: "dev-u2", role: "user", content: "(on the computer) go to the shop project", createdAt: at },
        { id: "dev-t2", role: "tool", content: '{"success":true,"action":"switch_project","projectId":"none"}', toolName: "switch_project", toolCallId: "tc-old", toolResult: { success: true, action: "switch_project", projectId: "none" }, createdAt: at },
        { id: "dev-a2", role: "assistant", content: "Moved.", createdAt: at }
      );
      stored.updatedAt = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(stored));
      await sleep(150);
      // The sync catches up while the turn runs.
      setTimeout(() => syncer.resume(), 1500);
      const second = await tell(cloud, "tg-count", "SLOW and what is the weather");
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.switchedProject, null, "an old switch from before this message moved the messenger's session");
    } finally {
      syncer.resume();
    }
  });

  await check("a switch made a moment ago is waited for like the rest of the chat, so the side that runs the turn never writes over it", async () => {
    const chat = crypto.randomUUID();
    await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "a plain cloud turn" }));
    await until("the chat on the computer", () => messagesOf(device, chat).length === 2 && sessionFilesOf(device.root, chat).length === 1);
    syncer.pause();
    try {
      // The switch changes the chat's file and adds no message.
      assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
      const calls = model.callsBy("device").length;
      const early = await post(cloud, "/api/chat", { chatId: chat, message: "run on the computer" });
      assert.equal(early.status, 409, "the computer ran the turn on a copy that does not know the chat was switched to it");
      assert.equal(((await early.json()) as { code?: string }).code, "not-synced");
      assert.equal(model.callsBy("device").length, calls);
    } finally {
      syncer.resume();
    }
    const read = await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "and now?" }));
    assert.match(read.text, /device answered\./, read.text);
  });

  await check("a file the sync never sends is not waited for", async () => {
    const chat = crypto.randomUUID();
    await readChatStream(await post(cloud, "/api/chat", { chatId: chat, message: "a plain cloud turn" }));
    await until("the chat on the computer", () => messagesOf(device, chat).length === 2 && sessionFilesOf(device.root, chat).length === 1);
    fs.mkdirSync(path.join(cloud.root, "data", "chat-files", chat), { recursive: true });
    // What a Mac leaves in a folder it has opened in Finder.
    fs.writeFileSync(path.join(cloud.root, "data", "chat-files", chat, ".DS_Store"), "finder");
    assert.equal((await post(cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
    const started = Date.now();
    const response = await post(cloud, "/api/chat", { chatId: chat, message: "run on the computer" });
    assert.equal(response.status, 200, "the computer waited for a file that never arrives");
    assert.match((await readChatStream(response)).text, /device answered\./);
    assert.ok(Date.now() - started < 5000, "it was held up all the same");
  });

  await check("the side that only relays writes nothing: with the sync held, the chat and the agent's record exist where the turn ran and nowhere else", async () => {
    // A messenger's chat that is already on the computer; the rest starts from nothing.
    const created = await tell(cloud, "tg-writes", "hello");
    const messengerChat = created.body.context.activeChatId as string;
    assert.equal((await post(cloud, "/api/chat/home", { chatId: messengerChat, home: "device:test-mac" })).status, 200);
    await until("the messenger's chat on the computer", () => messagesOf(device, messengerChat).length >= 2 && sessionFilesOf(device.root, messengerChat).length === 1);
    syncer.pause();
    try {
      const held = (side: Side, chat: string) => ({
        chat: readChatFile(side.root, chat) !== null,
        session: sessionFilesOf(side.root, chat).length,
        attachments: fs.existsSync(path.join(side.root, "data", "chat-files", chat)),
      });
      const nothing = { chat: false, session: 0, attachments: false };

      const plain = crypto.randomUUID();
      const stopped = crypto.randomUUID();
      const refused = crypto.randomUUID();
      const runs = await Promise.all([
        // A plain turn of a new chat, typed on the computer.
        post(device, "/api/chat", { chatId: plain, message: "plain handed-over turn", home: "cloud", projectId: "none" }).then((response) => readChatStream(response)),
        // A turn that is stopped.
        (async () => {
          const pending = post(device, "/api/chat", { chatId: stopped, message: "SLOW then stop", home: "cloud", projectId: "none" }).then((response) => readChatStream(response));
          await sleep(1400);
          await post(device, `/api/chat/${stopped}/stop`, {});
          return pending;
        })(),
      ]);
      assert.match(runs[0].text, /cloud answered\./);
      assert.deepEqual(held(device, plain), nothing, "the side that relayed a plain turn wrote something down");
      assert.deepEqual(held(device, stopped), nothing, "the side that relayed a stopped turn wrote something down");
      assert.equal(held(cloud, plain).chat, true);
      assert.equal(held(cloud, stopped).chat, true);

      // A handover that is refused.
      relay.state.deviceOnline = false;
      try {
        const answer = await post(cloud, "/api/chat", { chatId: refused, message: "to a computer that is off", home: "device:test-mac", projectId: "none" });
        assert.equal(answer.status, 409);
      } finally {
        relay.state.deviceOnline = true;
      }
      assert.deepEqual(held(cloud, refused), nothing, "a refused handover left a chat behind");

      // A messenger's turn: this side's copy of the chat does not move.
      const before = messagesOf(cloud, messengerChat).length;
      const reply = await tell(cloud, "tg-writes", "second, to the computer");
      assert.match(String(reply.body.reply), /device answered\./, JSON.stringify(reply.body));
      assert.equal(messagesOf(cloud, messengerChat).length, before, "the side that relayed a messenger's turn wrote it down");
    } finally {
      syncer.resume();
    }
  });

  await check("a turn given up on for going quiet says so to a messenger, as it does when it runs here", async () => {
    const b = await pairB();
    const local = await tell(b.cloud, "tg-hang-local", "HANG on this one");
    assert.match(String(local.body.reply), /I stopped this: nothing had happened/, String(local.body.reply));
    const first = await tell(b.cloud, "tg-hang", "hello");
    const chat = first.body.context.activeChatId as string;
    assert.equal((await post(b.cloud, "/api/chat/home", { chatId: chat, home: "device:test-mac" })).status, 200);
    await until("the chat on the computer", () => messagesOf(b.device, chat).length >= 2);
    const remote = await tell(b.cloud, "tg-hang", "HANG on this one too");
    assert.match(String(remote.body.reply), /partial words/, "what was said before it went quiet is lost");
    assert.match(String(remote.body.reply), /I stopped this: nothing had happened/, `the messenger was not told why: ${JSON.stringify(remote.body.reply)}`);
  });

  await check("stopping a turn that ran on the other side answers when the stored chat is here, however long the sync takes", async () => {
    const b = await pairB();
    b.syncer.setDelay(13_000);
    try {
      const chat = crypto.randomUUID();
      const pending = post(b.cloud, "/api/chat", { chatId: chat, message: "SLOW stop me later", home: "device:test-mac", projectId: "none" }).then((response) => readChatStream(response));
      await sleep(1500);
      const stop = await post(b.cloud, `/api/chat/${chat}/stop`, {});
      assert.equal(((await stop.json()) as { stopped?: boolean }).stopped, true);
      const history = (await (await get(b.cloud, `/api/chat/history?id=${chat}`)).json().catch(() => null)) as { messages?: unknown[] } | null;
      const onComputer = messagesOf(b.device, chat).length;
      assert.ok(onComputer >= 2, "the computer did not write the stopped turn down");
      assert.ok((history?.messages?.length ?? 0) >= onComputer, "the stop came back before the half-written turn was in this side's stored chat");
      await pending;
    } finally {
      b.syncer.setDelay(500);
    }
  });

  await check("no file was written on both sides at once in any of this", () => {
    // What each side held of a chat that was written on both, so that a failure says which one it was.
    const describe = (pair: { cloud: Side; device: Side }, key: string) => {
      const id = path.basename(key).replace(/\.json$/, "");
      const lines = (side: Side) => (readChatFile(side.root, id)?.messages ?? []).map((message) => `${message.role[0]}:${message.content.slice(0, 24)}`).join(" | ");
      return `${key}\n      cloud : ${lines(pair.cloud)}\n      device: ${lines(pair.device)}`;
    };
    assert.deepEqual(syncer.conflicts, [], `written on both sides:\n    ${syncer.conflicts.map((key) => describe({ cloud, device }, key)).join("\n    ")}`);
    if (spare.pair) assert.deepEqual(spare.pair.syncer.conflicts, [], `written on both sides:\n    ${spare.pair.syncer.conflicts.map((key) => describe(spare.pair!, key)).join("\n    ")}`);
  });
} finally {
  await spare.pair?.stop();
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
