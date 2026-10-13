/**
 * A chaos run for the handover: random messages, steers, stops, switches, a computer that comes and goes and a
 * sync that stalls and catches up, on a few chats at once, against two real processes. Then everything is let
 * settle and what must be true afterwards is checked:
 *
 *   - no chat is left "running" on either side (nothing leaked into the registry),
 *   - neither process died or logged an unhandled error,
 *   - no file was written on both sides at once (the single-writer rule held),
 *   - once the sync has caught up the two sides hold the same messages for every chat.
 *
 * Run with Node 22:  npm run chaos:remote -- [operations] [seed]
 * (about a minute for 50 operations; a failure prints the sequence, so it can be run again with the same seed)
 */
import fs from "node:fs";
import path from "node:path";
import { readChatFile, readChatStream, sleep, startModel, startRelay, startSide, startSyncer, type Side } from "./lib/remote-test-kit.ts";

const OPERATIONS = Number(process.argv[2] || 40);
let seed = Number(process.argv[3] || 4242);
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];

const repoRoot = path.resolve(import.meta.dirname, "..");
process.env.EGGENT_AUTH_SECRET = "remote-test-secret-0123456789abcdef";
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const session = await createSessionToken("owner@example.test", false);
const cookie = `${AUTH_COOKIE_NAME}=${session}`;
const JSON_HEADERS = { "content-type": "application/json", cookie };

const model = await startModel();
let cloud: Side;
let device: Side;
const relay = await startRelay({ cloud: () => cloud, device: () => device }, session);
const env = { EGGENT_REMOTE_COVER_WAIT_SECONDS: "4", EGGENT_REMOTE_SETTLE_WAIT_SECONDS: "6" };
cloud = await startSide({ name: "cloud", node: "cloud", relayUrl: relay.url("cloud"), modelUrl: model.url, repoRoot, env });
device = await startSide({ name: "device", node: "device:test-mac", relayUrl: relay.url("device"), modelUrl: model.url, repoRoot, env });
const syncer = startSyncer(cloud.root, device.root, { delayMs: 400 });

const post = (side: Side, route: string, body: unknown) => fetch(`${side.url}${route}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
const get = (side: Side, route: string) => fetch(`${side.url}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
const sides = { cloud, device } as const;

// A few chats, each created with a home so that who writes it is never in doubt.
const chats = Array.from({ length: 4 }, (_, index) => ({ id: crypto.randomUUID(), home: index % 2 === 0 ? ("cloud" as const) : ("device:test-mac" as const), created: false }));
const log: string[] = [];
const inflight: Promise<unknown>[] = [];
const note = (text: string) => log.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${text}`);
const started = Date.now();

async function send(chat: (typeof chats)[number], from: "cloud" | "device", text: string) {
  const body: Record<string, unknown> = { chatId: chat.id, message: text, projectId: "none" };
  // The screen names the home with every message until the chat is stored on the side it is typed on
  // (its menu choice stays set); once the file is there, the stored home says it.
  if (!readChatFile(sides[from].root, chat.id)) body.home = chat.home;
  chat.created = true;
  try {
    const response = await post(sides[from], "/api/chat", body);
    if (response.status === 200 && (response.headers.get("content-type") ?? "").includes("event-stream")) await readChatStream(response);
    else await response.text();
    note(`send ${text.slice(0, 18)} chat ${chat.id.slice(0, 4)} from ${from} -> ${response.status}`);
  } catch (error) {
    note(`send ${text.slice(0, 18)} chat ${chat.id.slice(0, 4)} from ${from} -> ${error instanceof Error ? error.message : error}`);
  }
}

for (let index = 0; index < OPERATIONS; index += 1) {
  const roll = rnd();
  const chat = pick(chats);
  const from = pick(["cloud", "device"] as const);
  if (roll < 0.5) {
    inflight.push(send(chat, from, `${rnd() < 0.5 ? "SLOW " : ""}message ${index}`));
  } else if (roll < 0.62) {
    inflight.push(post(sides[from], `/api/chat/${chat.id}/stop`, {}).then((response) => response.text()).then((text) => note(`stop chat ${chat.id.slice(0, 4)} on ${from}: ${text.slice(0, 40)}`)).catch(() => undefined));
  } else if (roll < 0.72) {
    const target = pick(["cloud", "device:test-mac"] as const);
    inflight.push(
      post(sides[from], "/api/chat/home", { chatId: chat.id, home: target })
        .then(async (response) => {
          note(`switch chat ${chat.id.slice(0, 4)} to ${target} from ${from}: ${response.status}`);
          if (response.status === 200 && chat.created) chat.home = target;
          await response.text();
        })
        .catch(() => undefined)
    );
  } else if (roll < 0.82) {
    relay.state.deviceOnline = !relay.state.deviceOnline;
    note(`computer ${relay.state.deviceOnline ? "back" : "away"}`);
  } else if (roll < 0.92) {
    if (rnd() < 0.5) {
      syncer.pause();
      note("sync held");
    } else {
      syncer.resume();
      note("sync released");
    }
  } else {
    // a steer: a message straight after another for the same chat
    inflight.push(send(chat, from, `SLOW first of a pair ${index}`));
    await sleep(300);
    inflight.push(send(chat, pick(["cloud", "device"] as const), `and a second ${index}`));
  }
  await sleep(Math.floor(rnd() * 900));
}

// let everything settle
relay.state.deviceOnline = true;
syncer.resume();
note("settling");
await Promise.race([Promise.allSettled(inflight), sleep(120_000)]);

async function running(side: Side, chatId: string): Promise<boolean> {
  try {
    const head = (await (await get(side, `/api/chat/${chatId}/head`)).json()) as { running?: boolean };
    return head.running === true;
  } catch {
    return false;
  }
}
const deadline = Date.now() + 90_000;
for (;;) {
  const states = await Promise.all(chats.flatMap((chat) => [running(cloud, chat.id), running(device, chat.id)]));
  if (states.every((value) => !value) || Date.now() > deadline) break;
  await sleep(1000);
}
await sleep(6000); // the sync catches up

const problems: string[] = [];
for (const chat of chats) {
  for (const [name, side] of [["cloud", cloud], ["device", device]] as const) {
    if (await running(side, chat.id)) problems.push(`chat ${chat.id.slice(0, 4)} is still "running" on the ${name}`);
  }
  const a = readChatFile(cloud.root, chat.id);
  const b = readChatFile(device.root, chat.id);
  if (!!a !== !!b) problems.push(`chat ${chat.id.slice(0, 4)} exists on one side only`);
  if (a && b) {
    const ids = (file: NonNullable<typeof a>) => file.messages.map((message) => message.id).join(",");
    if (ids(a) !== ids(b)) problems.push(`chat ${chat.id.slice(0, 4)} differs: cloud ${a.messages.length} messages, device ${b.messages.length}`);
  }
}
if (syncer.conflicts.length > 0) problems.push(`written on both sides at once: ${syncer.conflicts.join(", ")}`);
for (const side of [cloud, device]) {
  if (side.process.exitCode !== null) problems.push(`${side.name} died (exit ${side.process.exitCode})`);
  const text = side.log.join("");
  for (const line of text.split("\n")) {
    if (/unhandled|uncaught|TypeError|ReferenceError/i.test(line) && !/AbortError/.test(line)) problems.push(`${side.name} logged: ${line.slice(0, 160)}`);
  }
}

console.log(log.join("\n"));
console.log(`\n${OPERATIONS} operations, seed ${process.argv[3] || 4242}: ${problems.length === 0 ? "held" : "PROBLEMS"}`);
for (const problem of problems) console.log("  - " + problem);
if (problems.length > 0) {
  for (const side of [cloud, device]) console.log(`--- ${side.name} log tail ---\n${side.log.join("").slice(-1800)}`);
}

syncer.stop();
await cloud.stop();
await device.stop();
await relay.close();
await model.close();
fs.rmSync(cloud.root, { recursive: true, force: true });
fs.rmSync(device.root, { recursive: true, force: true });
process.exit(problems.length > 0 ? 1 : 0);
