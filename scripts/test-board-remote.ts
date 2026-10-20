/**
 * The task board across a paired workspace and computer.
 *
 * Two real processes - a workspace ("cloud") and a computer ("device") - each
 * running the board's own routes and runner, joined by a stand-in control plane
 * and a slow stand-in for the file sync that carries the board's folder along
 * with the conversations. A stub model says which side asked it. What is
 * checked: one board on both sides; the cloud alone starts cards; a card that
 * lives on the computer runs there, handed over the way its chats are, and
 * waits while the computer is away; a question asked over there waits on the
 * card here and the answer carries on there; Stop reaches a card from either
 * side; a message in a card's chat - typed on either side, or from a messenger -
 * is followed by the card once, by the side that runs it or, for a turn nobody
 * watches over there, by the side that handed it over; a run the computer no
 * longer has is noticed and one it still has is left alone; moving a card's
 * chat moves the card; and a side outside the pair never starts a card that
 * belongs to one.
 *
 * Run with Node 22:  npm run test:board-remote
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readChatFile, readChatStream, sleep, startModel, startRelay, startSide, startSyncer, type Side } from "./lib/remote-test-kit.ts";

process.env.EGGENT_AUTH_SECRET = "remote-test-secret-0123456789abcdef";
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const session = await createSessionToken("owner@example.test", false);
const cookie = `${AUTH_COOKIE_NAME}=${session}`;
const repoRoot = path.resolve(import.meta.dirname, "..");

let failed = 0;
let ran = 0;
const CHECK_TIMEOUT_MS = 120_000;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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
const env = { BOARD: "1", EGGENT_BOARD_RETRY_SECONDS: "0", EGGENT_REMOTE_STOP_GRACE_SECONDS: "3", EGGENT_BOARD_ORPHAN_GRACE_SECONDS: "2" };
cloud = await startSide({ name: "cloud", node: "cloud", relayUrl: relay.url("cloud"), modelUrl: model.url, repoRoot, env });
device = await startSide({ name: "device", node: "device:test-mac", relayUrl: relay.url("device"), modelUrl: model.url, repoRoot, env });
const syncer = startSyncer(cloud.root, device.root, { delayMs: 600, dirs: ["data/chats", "data/pi-sessions", "data/chat-files", "data/board"] });
// A side that is not part of any pair, holding a copy of a paired board.
const loner = await startSide({ name: "loner", node: "", relayUrl: "", modelUrl: model.url, repoRoot, env });
// A workspace whose pairing was switched off: it is still told it is the cloud, and has no road.
const unpaired = await startSide({ name: "unpaired", node: "cloud", relayUrl: "", modelUrl: model.url, repoRoot, env });

const JSON_HEADERS = { "content-type": "application/json", cookie };
async function api(side: Side, method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${side.url}${route}`, {
    method,
    headers: body === undefined ? { cookie } : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}
interface Card {
  id: string;
  status: string;
  home?: string;
  waiting?: { reason: string; detail?: string };
  question?: { text: string };
  result?: { text: string };
  runs: Array<{ id: string; outcome?: string; node?: string; surface?: string; startedAt: string; endedAt?: string }>;
}
async function chatTurn(side: Side, body: Record<string, unknown>) {
  return readChatStream(await fetch(`${side.url}/api/chat`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }));
}
/** Any change to a card makes a side look at its board; this one makes the cloud look now. */
async function poke(side: Side): Promise<void> {
  const { json } = await api(side, "POST", "/api/board/cards", { title: "poke", body: "poke" });
  await api(side, "DELETE", `/api/board/cards/${(json.card as Card).id}`);
}
async function cardOn(side: Side, id: string): Promise<Card | null> {
  const { status, json } = await api(side, "GET", `/api/board/cards/${id}`);
  return status === 200 ? (json.card as Card) : null;
}
async function create(side: Side, fields: Record<string, unknown>): Promise<Card> {
  const { status, json } = await api(side, "POST", "/api/board/cards", fields);
  assert.equal(status, 201, JSON.stringify(json));
  return json.card as Card;
}
async function until<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await sleep(150);
  }
  const card = last as unknown as Card | null;
  const shown = card && typeof card === "object" && Array.isArray((card as Card).runs)
    ? `${card.status}${card.waiting ? `/${card.waiting.reason}` : ""} runs=[${card.runs.map((run) => `${run.surface}:${run.outcome ?? "open"}@${run.node ?? "-"}`).join(" ")}] result=${JSON.stringify(card.result?.text?.slice(0, 80))}`
    : JSON.stringify(last)?.slice(0, 400);
  throw new Error(`timed out waiting for ${label}; last ${shown}`);
}
const settled = (status: string) => (card: Card | null) => Boolean(card && card.status === status && card.runs.every((run) => run.endedAt));

try {
  await check("a card made in the cloud runs in the cloud, and the computer sees the same board", async () => {
    const before = model.callsBy("device").length;
    const card = await create(cloud, { title: "Cloud work", body: "say hello from the board", start: true });
    assert.equal(card.home, "cloud", "a card made in a pair goes to the cloud unless somebody says otherwise");
    const done = await until("the cloud card", () => cardOn(cloud, card.id), settled("done"));
    assert.match(done!.result!.text, /^cloud answered\./);
    assert.equal(done!.runs[0].node, "cloud");
    assert.equal(model.callsBy("device").length, before, "the computer ran a cloud card");
    const onDevice = await until("the card on the computer's board", () => cardOn(device, card.id), settled("done"));
    assert.match(onDevice!.result!.text, /^cloud answered\./);
  });

  await check("a card that lives on the computer runs there, handed over like its chats; the cloud keeps the card", async () => {
    const card = await create(cloud, { title: "Mac work", body: "do it on the mac", home: "device:test-mac", start: true });
    const done = await until("the computer's card", () => cardOn(cloud, card.id), settled("done"));
    assert.match(done!.result!.text, /^device answered\./, `answered by ${done!.result!.text}`);
    assert.equal(done!.runs[0].node, "device:test-mac");
    // The conversation lives on the computer, as the card does.
    const chatHere = readChatFile(cloud.root, card.id);
    assert.equal(chatHere?.home, "device:test-mac");
    assert.ok(relay.state.carried.some((carried) => carried.from === "cloud" && carried.path === "/api/chat"), "nothing was handed over");
  });

  await check("a card made on the computer for the cloud is started by the cloud, never by the computer", async () => {
    const before = model.callsBy("device").length;
    const card = await create(device, { title: "From the mac", body: "run this in the cloud", home: "cloud" });
    const moved = await api(device, "PATCH", `/api/board/cards/${card.id}`, { move: { to: "queued" } });
    assert.equal(moved.status, 200);
    const done = await until("the card to come back done", () => cardOn(device, card.id), settled("done"));
    assert.match(done!.result!.text, /^cloud answered\./);
    assert.equal(model.callsBy("device").length, before, "the computer started a card itself");
  });

  await check("a computer cannot put a card on another computer", async () => {
    const { status } = await api(device, "POST", "/api/board/cards", { title: "x", body: "y", home: "device:someone-else" });
    assert.equal(status, 400);
  });

  await check("a card for a computer that is away waits in the queue, and runs when it is back", async () => {
    relay.state.deviceOnline = false;
    let card: Card;
    try {
      card = await create(cloud, { title: "Later on the mac", body: "when you are back", home: "device:test-mac", start: true });
      await sleep(25_000);
      const waiting = await cardOn(cloud, card.id);
      assert.equal(waiting?.status, "queued", `the card did not wait: ${waiting?.status} ${JSON.stringify(waiting?.waiting)}`);
      assert.equal(waiting?.runs.length, 0, "a run was recorded while the computer was away");
    } finally {
      relay.state.deviceOnline = true;
    }
    const done = await until("the card once the computer is back", () => cardOn(cloud, card.id), settled("done"), 90_000);
    assert.match(done!.result!.text, /^device answered\./);
  });

  await check("a question asked on the computer waits on the card in the cloud, and the answer carries on there", async () => {
    const card = await create(cloud, { title: "Ask on the mac", body: "ASK-ME what you need", home: "device:test-mac", start: true });
    const waiting = await until("the question", () => cardOn(cloud, card.id), settled("waiting"));
    assert.equal(waiting!.waiting?.reason, "question");
    assert.equal(waiting!.question?.text, "Which colour?");
    // The computer wrote nothing of the card's own: its copy is the cloud's, brought over.
    const answered = await api(cloud, "POST", `/api/board/cards/${card.id}/answer`, { text: "blue" });
    assert.equal(answered.status, 200);
    const done = await until("the answer to be used on the computer", () => cardOn(cloud, card.id), settled("done"));
    assert.match(done!.result!.text, /^device answered\./);
    assert.match(done!.result!.text, /ctx users=2 last=.*blue/, JSON.stringify(done!.result));
  });

  await check("a computer that says no is not asked again by itself: the card waits for the person", async () => {
    relay.state.denyTurns = true;
    try {
      const card = await create(cloud, { title: "Not allowed", body: "try the mac", home: "device:test-mac", start: true });
      const waiting = await until("the refusal", () => cardOn(cloud, card.id), settled("waiting"));
      assert.equal(waiting!.waiting?.reason, "failed");
      assert.equal(waiting!.runs.length, 1, "it was tried again without the person");
      await sleep(5000);
      assert.equal((await cardOn(cloud, card.id))!.runs.length, 1);
    } finally {
      relay.state.denyTurns = false;
    }
  });

  await check("Stop in the cloud stops a card working on the computer", async () => {
    const card = await create(cloud, { title: "Long on the mac", body: "HANG there", home: "device:test-mac", start: true });
    await until("the card to work", () => cardOn(cloud, card.id), (value) => value?.status === "running");
    await sleep(3000);
    const stopped = await api(cloud, "POST", `/api/board/cards/${card.id}/stop`, {});
    assert.equal(stopped.status, 200);
    const after = await until("the stop", () => cardOn(cloud, card.id), settled("waiting"));
    assert.equal(after!.waiting?.reason, "stopped");
  });

  await check("Stop on the computer stops a card working in the cloud", async () => {
    const card = await create(cloud, { title: "Long in the cloud", body: "HANG here", start: true });
    await until("the card to work", () => cardOn(cloud, card.id), (value) => value?.status === "running");
    await until("the computer to see it working", () => cardOn(device, card.id), (value) => value?.status === "running");
    const stopped = await api(device, "POST", `/api/board/cards/${card.id}/stop`, {});
    assert.equal(stopped.status, 200);
    const after = await until("the stop", () => cardOn(cloud, card.id), settled("waiting"));
    assert.equal(after!.waiting?.reason, "stopped");
  });


  await check("a computer is told whether the cloud can hand it a card; the cloud is told about its computers", async () => {
    const here = await api(device, "GET", "/api/remote/status");
    assert.equal((here.json.self as { node?: string } | null)?.node, "device:test-mac", JSON.stringify(here.json));
    assert.deepEqual(here.json.devices, []);
    const there = await api(cloud, "GET", "/api/remote/status");
    assert.equal(there.json.self, null);
    assert.equal((there.json.devices as Array<{ node: string }>)[0]?.node, "device:test-mac");
  });

  let follow: Card;
  const doneWith = (count: number) => (card: Card | null) => Boolean(card && card.status === "done" && card.runs.length === count && card.runs.every((run) => run.endedAt));
  await check("a message typed on the computer in its card's chat is followed by the card, on both sides", async () => {
    follow = await create(cloud, { title: "Follow me", body: "write a line", home: "device:test-mac", start: true });
    await until("its first run", () => cardOn(cloud, follow.id), doneWith(1));
    await until("its chat on the computer", async () => readChatFile(device.root, follow.id)?.messages.length ?? 0, (count) => count >= 2);
    await until("the card on the computer", () => cardOn(device, follow.id), doneWith(1));
    const read = await chatTurn(device, { chatId: follow.id, message: "and one more thing" });
    assert.match(read.text, /device answered\./, read.text);
    for (const side of [device, cloud]) {
      const card = await until(`the card ${side.name}`, () => cardOn(side, follow.id), doneWith(2));
      assert.match(card!.result!.text, /and one more thing/, `${side.name}: ${card!.result!.text}`);
      assert.equal(card!.runs.at(-1)!.surface, "web");
      assert.equal(card!.runs.at(-1)!.node, "device:test-mac");
    }
  });

  await check("a message typed in the cloud in a computer card's chat runs there and is followed once", async () => {
    const read = await chatTurn(cloud, { chatId: follow.id, message: "from the cloud screen" });
    assert.match(read.text, /device answered\./, read.text);
    const card = await until("the card", () => cardOn(cloud, follow.id), doneWith(3));
    assert.match(card!.result!.text, /from the cloud screen/);
    assert.equal(card!.runs.at(-1)!.node, "device:test-mac");
    await sleep(2_000);
    assert.equal((await cardOn(cloud, follow.id))!.runs.length, 3, "the turn was followed on both sides");
  });

  await check("a messenger's message in a computer card's chat is followed by the cloud that handed it over, once", async () => {
    const response = await fetch(`${cloud.url}/api/external/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-external-token" },
      body: JSON.stringify({ sessionId: "tg-board", chatId: follow.id, message: "from the messenger", toolRuntimeData: { telegram: { chatId: 4343, botToken: "123:fake" } } }),
      signal: AbortSignal.timeout(80_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.match(String(body.reply), /device answered\./);
    const card = await until("the card", () => cardOn(cloud, follow.id), doneWith(4));
    assert.equal(card!.runs.at(-1)!.surface, "external");
    assert.equal(card!.runs.at(-1)!.node, "device:test-mac");
    assert.match(card!.result!.text, /from the messenger/);
    await sleep(2_000);
    assert.equal((await cardOn(cloud, follow.id))!.runs.length, 4, "the turn was followed on both sides");
  });

  await check("a turn still going on the computer is left alone by the cloud, and Stop in the cloud ends it", async () => {
    // A person writes once what the other side wrote has arrived, as seconds later it has.
    const runs = (await cardOn(cloud, follow.id))!.runs.length;
    await until("the card on the computer", () => cardOn(device, follow.id), (card) => card?.runs.length === runs);
    const pending = chatTurn(device, { chatId: follow.id, message: "HANG for a while" });
    await until("the card working, in the cloud", () => cardOn(cloud, follow.id), (card) => card?.status === "running" && card.runs.at(-1)?.node === "device:test-mac");
    await sleep(2_500);
    await poke(cloud);
    await sleep(3_000);
    const still = await cardOn(cloud, follow.id);
    assert.equal(still!.status, "running", `the cloud gave up on a turn that was going on: ${JSON.stringify(still!.runs.at(-1))}`);
    const stop = await api(cloud, "POST", `/api/board/cards/${follow.id}/stop`, {});
    assert.equal(stop.status, 200, JSON.stringify(stop.json));
    await pending;
    const after = await until("the stop", () => cardOn(cloud, follow.id), settled("waiting"));
    assert.equal(after!.waiting?.reason, "stopped");
  });

  await check("a run the computer no longer has is noticed by the cloud, and the card carries on there", async () => {
    // As a computer that crashed mid-turn leaves it: the card says working, and nothing is.
    const file = path.join(cloud.root, "data", "board", "cards", `${follow.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    const lostRun = { id: crypto.randomUUID(), surface: "web", node: "device:test-mac", startedAt: new Date(Date.now() - 180_000).toISOString() };
    fs.writeFileSync(file, JSON.stringify({ ...stored, status: "running", waiting: undefined, runs: [...stored.runs, lostRun], updatedAt: new Date().toISOString() }));
    const runsBefore = stored.runs.length + 1;
    await poke(cloud);
    const card = await until("the card carrying on", () => cardOn(cloud, follow.id), (current) => Boolean(current && current.status === "done" && current.runs.length >= runsBefore + 1 && current.runs.every((run) => run.endedAt)));
    assert.equal(card!.runs.find((run) => run.id === lostRun.id)?.outcome, "interrupted");
    assert.equal(card!.runs.at(-1)!.node, "device:test-mac");
    assert.match(card!.result!.text, /^device answered\./);
  });

  await check("Stop in the cloud closes a card whose computer went away mid-run", async () => {
    const file = path.join(cloud.root, "data", "board", "cards", `${follow.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    const goneRun = { id: crypto.randomUUID(), surface: "web", node: "device:test-mac", startedAt: new Date(Date.now() - 180_000).toISOString() };
    relay.state.deviceOnline = false;
    try {
      fs.writeFileSync(file, JSON.stringify({ ...stored, status: "running", waiting: undefined, runs: [...stored.runs, goneRun], updatedAt: new Date().toISOString() }));
      await poke(cloud);
      await sleep(1_500);
      assert.equal((await cardOn(cloud, follow.id))!.status, "running", "a computer that cannot be asked was taken to have given up");
      const stop = await api(cloud, "POST", `/api/board/cards/${follow.id}/stop`, {});
      assert.equal(stop.status, 200, JSON.stringify(stop.json));
      const card = await until("the stop", () => cardOn(cloud, follow.id), settled("waiting"));
      assert.equal(card!.waiting?.reason, "stopped");
      assert.equal(card!.runs.find((run) => run.id === goneRun.id)?.outcome, "stopped");
    } finally {
      relay.state.deviceOnline = true;
    }
  });

  await check("moving a card's chat to the cloud moves the card, and its next run is there", async () => {
    const flip = await api(cloud, "POST", "/api/chat/home", { chatId: follow.id, home: "cloud" });
    assert.equal(flip.status, 200, JSON.stringify(flip.json));
    await until("the card moved", () => cardOn(cloud, follow.id), (card) => card?.home === "cloud");
    const runs = (await cardOn(cloud, follow.id))!.runs.length;
    const again = await api(cloud, "PATCH", `/api/board/cards/${follow.id}`, { move: { to: "queued" } });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const card = await until("its run", () => cardOn(cloud, follow.id), doneWith(runs + 1));
    assert.match(card!.result!.text, /^cloud answered\./);
  });

  await check("a side outside the pair never starts a card that belongs to one", async () => {
    // The loner holds a copy of the paired board, as a computer does after signing out.
    const card = await create(cloud, { title: "Paired only", body: "not for the loner", home: "cloud" });
    await until("the card file", async () => fs.existsSync(path.join(cloud.root, "data", "board", "cards", `${card.id}.json`)), Boolean);
    fs.mkdirSync(path.join(loner.root, "data", "board", "cards"), { recursive: true });
    const copy = JSON.parse(fs.readFileSync(path.join(cloud.root, "data", "board", "cards", `${card.id}.json`), "utf-8"));
    const pairedId = crypto.randomUUID();
    fs.writeFileSync(path.join(loner.root, "data", "board", "cards", `${pairedId}.json`), JSON.stringify({ ...copy, id: pairedId, status: "queued" }));
    assert.equal((await cardOn(loner, pairedId))?.status, "queued", "the copy is not a card the loner can read");
    const before = model.callsBy("loner").length;
    await poke(loner);
    await sleep(3_000);
    assert.equal(model.callsBy("loner").length, before, "the loner started a paired card");
    // Its own cards it runs as ever, and the paired one is still left where it was.
    const own = await create(loner, { title: "Mine", body: "just mine", start: true });
    assert.equal(own.home, undefined);
    const done = await until("the loner's own card", () => cardOn(loner, own.id), settled("done"));
    assert.match(done!.result!.text, /^loner answered\./);
    const paired = await cardOn(loner, pairedId);
    assert.equal(paired?.status, "queued");
    assert.equal(paired?.runs.length, 0, "the loner started a paired card");
  });

  await check("a workspace whose pairing is switched off still runs the cards it gave the cloud, and not a computer's", async () => {
    const dir = path.join(unpaired.root, "data", "board", "cards");
    fs.mkdirSync(dir, { recursive: true });
    const template = JSON.parse(fs.readFileSync(path.join(cloud.root, "data", "board", "cards", `${follow.id}.json`), "utf-8"));
    const fresh = (home: string, title: string) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...template, id, title, body: title, home, status: "queued", runs: [], result: undefined, waiting: undefined, failures: 0, interruptions: 0, createdAt: now, updatedAt: now }));
      return id;
    };
    const ours = fresh("cloud", "still ours");
    const theirs = fresh("device:test-mac", "the computer's");
    await poke(unpaired);
    const done = await until("its own card", () => cardOn(unpaired, ours), settled("done"));
    assert.match(done!.result!.text, /^unpaired answered\./);
    const left = await cardOn(unpaired, theirs);
    assert.equal(left?.status, "queued");
    assert.equal(left?.runs.length, 0, "a computer's card was run without its computer");
  });

  await check("the sync left no conflict copies of cards behind", () => {
    for (const side of [cloud, device]) {
      const names = fs.readdirSync(path.join(side.root, "data", "board", "cards"));
      assert.ok(!names.some((name) => name.includes("sync-conflict")), `${side.name}: ${names.join(", ")}`);
    }
    const boardConflicts = syncer.conflicts.filter((key) => key.startsWith("data/board"));
    assert.ok(boardConflicts.length <= 1, `cards written on both sides at once: ${boardConflicts.join(", ")}`);
  });
} finally {
  syncer.stop();
  await cloud.stop();
  await device.stop();
  await loner.stop();
  await unpaired.stop();
  await relay.close();
  await model.close();
  for (const side of [cloud, device, loner]) fs.rmSync(side.root, { recursive: true, force: true });
}

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed > 0 ? 1 : 0);
