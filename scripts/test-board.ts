/**
 * The task board: cards the agent carries out one by one, each in a chat of its own.
 *
 * Drives the real board - its store, its runner, the chat runners it shares
 * with every other surface, its routes - against a stub provider that answers
 * by what each card says. What is checked is what a person would find out the
 * hard way: a card runs and its last answer is its result; a card that waits
 * for another starts after it, with what it came to; a question nobody is
 * there to answer waits on the card and the answer carries on; a failure is
 * retried once and then waits; a refusal pauses the whole board; no more run at
 * once than the limit, and never two in one project's folder; a restart in the
 * middle is picked up again; the agent proposes and only the person starts;
 * and a page on another site cannot put work in the queue.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:board
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

let failed = 0;
let ran = 0;
const only = process.env.EGGENT_TEST_ONLY?.trim();
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (only && !name.includes(only)) return;
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const PROVIDER = "stub";
const MODEL = "stub-model";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(delta: Record<string, unknown>, finish: string | null = null, id = "stub-completion"): string {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
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

interface SeenRequest {
  system: string;
  tools: string[];
  lastUser: string;
  lastRole: string;
  project: string;
}
const seen: SeenRequest[] = [];
const activeByProject = new Map<string, number>();
let active = 0;
let maxActive = 0;
let maxSameProject = 0;
const failOnce = new Set<string>();
const hanging = new Set<http.ServerResponse>();

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
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
    const messages = payload.messages ?? [];
    const tools = (payload.tools ?? []).map((tool) => tool.function?.name ?? "");
    const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content)).join("\n");
    const lastUser = textOf([...messages].reverse().find((message) => message.role === "user")?.content);
    const everyUser = messages.filter((message) => message.role === "user").map((message) => textOf(message.content)).join("\n");
    const lastRole = messages[messages.length - 1]?.role ?? "";
    const project = /Project id: ([^\n]+)/.exec(system)?.[1]?.trim() ?? "?";
    seen.push({ system, tools, lastUser, lastRole, project });

    const stream = () => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const reply = (text: string, id?: string) => {
      stream();
      res.write(chunk({ role: "assistant" }, null, id));
      res.write(chunk({ content: text }, null, id));
      res.write(chunk({}, "stop", id));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const call = (name: string, args: Record<string, unknown>) => {
      stream();
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ tool_calls: [{ index: 0, id: `call-${name}-${seen.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const refuse = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
    };

    if (lastUser.includes("HANG") && lastRole !== "tool") {
      hanging.add(res);
      res.on("close", () => hanging.delete(res));
      stream();
      res.write(chunk({ role: "assistant" }));
      return;
    }
    if (lastUser.includes("ASK-ME")) {
      if (lastRole !== "tool") return call("eggent_ask_user", { question: "Which city?", options: ["Paris", "Rome"] });
      // The run should have ended at the question: this answer arriving would be the bug.
      await sleep(1500);
      return reply("SHOULD-NOT-BE-SEEN");
    }
    if (lastUser.trim() === "Paris") return reply("weather for Paris");
    // Whatever the run is told - a retry says so in words of its own - this card's conversation always fails.
    if (everyUser.includes("FAIL-ALWAYS")) return refuse(400, "the stub refuses this card");
    const failKey = /FAIL-ONCE-\w+/.exec(lastUser)?.[0];
    if (failKey && !failOnce.has(failKey)) {
      failOnce.add(failKey);
      return refuse(400, "the stub fails this once");
    }
    if (lastUser.includes("REFUSE")) return reply("Your balance is spent. Top up to go on.", "eggent_limit_1791700000000");
    if (lastUser.includes("PROPOSE") && lastRole !== "tool") {
      return call("eggent_board", {
        action: "create",
        cards: [
          { title: "Step one", task: "do the first part" },
          { title: "Step two", task: "do the second part", after: ["#1"] },
        ],
      });
    }
    if (lastUser.includes("PROPOSE") && lastRole === "tool") return reply("proposed two cards");
    if (lastUser.includes("parent apples")) return reply("result of A: 7 apples");
    if (lastUser.includes("7 apples")) return reply("B saw what A found");
    const slow = /SLOW-(\d+)/.exec(lastUser);
    if (slow) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const inProject = (activeByProject.get(project) ?? 0) + 1;
      activeByProject.set(project, inProject);
      maxSameProject = Math.max(maxSameProject, inProject);
      await sleep(Number(slow[1]));
      active -= 1;
      activeByProject.set(project, (activeByProject.get(project) ?? 1) - 1);
      return reply(`slow done ${slow[0]}`);
    }
    if (lastUser.includes("carry on") || lastUser.includes("Carry on")) return reply("carried on and finished");
    return reply(`ok: ${lastUser.slice(0, 40)}`);
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-board-"));
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
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, retry: { enabled: false } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
process.env.EGGENT_BOARD_RETRY_SECONDS = "0";
process.env.EGGENT_AUTH_SECRET = "board-test-secret-0123456789abcdef";

const projectStore = await import("../src/lib/storage/project-store.ts");
const { runPiAgentText, createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { getChat, getAllChats } = await import("../src/lib/storage/chat-store.ts");
const { getActiveRun } = await import("../src/lib/pi/active-runs.ts");
const store = await import("../src/lib/board/store.ts");
const logic = await import("../src/lib/board/logic.ts");
const cards = await import("../src/lib/board/cards.ts");
const dispatcher = await import("../src/lib/board/dispatcher.ts");
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const { NextRequest } = await import("next/server.js");
const cardsRoute = await import("../src/app/api/board/cards/route.ts");
const cardRoute = await import("../src/app/api/board/cards/[id]/route.ts");

fs.mkdirSync(path.join(root, "data", "projects", "skills"), { recursive: true });
for (const id of ["p1", "p2", "p3", "p4"]) {
  await projectStore.createProject({ id, name: id.toUpperCase(), description: "", instructions: `${id} instructions`, memoryMode: "isolated" } as never);
}

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T = await read();
  while (Date.now() < until) {
    last = await read();
    if (ok(last)) return last;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)?.slice(0, 600)}`);
}
const cardOf = (id: string) => async () => store.getCard(id);
const settled = (statuses: string[]) => (card: Awaited<ReturnType<typeof store.getCard>>) => Boolean(card && statuses.includes(card.status) && !getActiveRun(card.id));
const lastUserOf = async (chatId: string) => (await getChat(chatId))?.messages.filter((message) => message.role === "user").pop()?.content ?? "";

// ---------------------------------------------------------------- the rules alone
console.log("The rules\n");

const baseCard = (patch: Partial<import("../src/lib/board/types.ts").BoardCard> = {}): import("../src/lib/board/types.ts").BoardCard => ({
  id: crypto.randomUUID(),
  title: "t",
  body: "b",
  status: "queued",
  position: 1,
  createdBy: "person",
  runs: [],
  failures: 0,
  interruptions: 0,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...patch,
});
const texts = { retry: (detail?: string) => `retry: ${detail}`, resume: "resume" };

await check("the queue is read top to bottom, a project's card skipped - not the queue stopped - when its project is full", () => {
  const a = baseCard({ projectId: "x", position: 1 });
  const b = baseCard({ projectId: "x", position: 2 });
  const c = baseCard({ projectId: "y", position: 3 });
  const picked = logic.pickCardsToStart([c, b, a], { limits: { running: 3, perProject: 1 }, liveByScope: new Map(), now: Date.now() });
  assert.deepEqual(picked.map((card) => card.id), [a.id, c.id]);
});
await check("no more start than the limit allows, counting what already runs", () => {
  const list = [1, 2, 3, 4].map((position) => baseCard({ projectId: `p${position}`, position }));
  const picked = logic.pickCardsToStart(list, { limits: { running: 3, perProject: 1 }, liveByScope: new Map([["other", 2]]), now: Date.now() });
  assert.equal(picked.length, 1);
});
await check("a card waits for its parents, and for its retry time", () => {
  const parent = baseCard({ status: "running" });
  const child = baseCard({ after: [parent.id], position: 0 });
  const later = baseCard({ retryAt: new Date(Date.now() + 60_000).toISOString() });
  const picked = logic.pickCardsToStart([parent, child, later], { limits: { running: 5, perProject: 5 }, liveByScope: new Map(), now: Date.now() });
  assert.equal(picked.length, 0);
});
await check("a circle of cards that wait for each other is seen", () => {
  const a = baseCard();
  const b = baseCard({ after: [a.id] });
  assert.equal(logic.wouldCycle([a, b], a.id, [b.id]), true);
  assert.equal(logic.wouldCycle([a, b], b.id, [a.id]), false);
});
await check("a finished run is the card's result; one that asked for a check waits for it", () => {
  const done = logic.applyRunEnd(baseCard({ status: "running" }), { outcome: "done", finalText: "the answer" }, { now: new Date(), texts });
  assert.equal(done.status, "done");
  assert.equal(done.result?.text, "the answer");
  const review = logic.applyRunEnd(baseCard({ status: "running", review: true }), { outcome: "done", finalText: "x" }, { now: new Date(), texts });
  assert.equal(review.status, "waiting");
  assert.equal(review.waiting?.reason, "review");
});
await check("a failure is retried once by itself, then waits for the person", () => {
  const first = logic.applyRunEnd(baseCard({ status: "running" }), { outcome: "failed", detail: "boom" }, { now: new Date(), texts });
  assert.equal(first.status, "queued");
  assert.equal(first.next?.kind, "retry");
  assert.match(first.next?.text ?? "", /boom/);
  const second = logic.applyRunEnd({ ...first, status: "running" }, { outcome: "failed", detail: "boom" }, { now: new Date(), texts });
  assert.equal(second.status, "waiting");
  assert.equal(second.waiting?.reason, "failed");
  // A run somebody started from the chat is theirs: not retried behind their back.
  const fromChat = logic.applyRunEnd(baseCard({ status: "running" }), { outcome: "failed" }, { now: new Date(), texts, surface: "web" });
  assert.equal(fromChat.status, "waiting");
});
await check("a restart is resumed twice in a row, not for ever", () => {
  let card = baseCard({ status: "running" });
  for (let round = 0; round < 2; round += 1) {
    card = logic.applyRunEnd(card, { outcome: "interrupted" }, { now: new Date(), texts });
    assert.equal(card.status, "queued");
    card = { ...card, status: "running" };
  }
  card = logic.applyRunEnd(card, { outcome: "interrupted" }, { now: new Date(), texts });
  assert.equal(card.status, "waiting");
  assert.equal(card.waiting?.reason, "interrupted");
});
await check("a card that waited for others starts with what they came to", () => {
  const parent = baseCard({ title: "Count", status: "done", result: { text: "7 apples", at: "", files: [{ project: "p1", items: [{ path: "out.md", size: 1, source: "tool" }], total: 1 }] } });
  const child = baseCard({ body: "use it", after: [parent.id] });
  const message = logic.firstMessage(child, [parent], { parents: "Before:", files: "Files", filePath: (project, file) => `/x/${project}/${file}` });
  assert.match(message, /^use it/);
  assert.match(message, /### Count\n7 apples/);
  assert.match(message, /Files: \/x\/p1\/out\.md/);
});

console.log("\nThe store\n");

await check("an id that is not a card's is never looked up, so no request can name a path", async () => {
  assert.equal(await store.getCard("../../etc/passwd"), null);
  assert.equal(store.isCardId("../x"), false);
});
await check("changes to one card land one after another, none written over", async () => {
  const [card] = await cards.createCards([{ title: "counter", body: "n" }], { createdBy: "person" });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.updateCard(card.id, (current) => ({ ...current, body: `${current.body}${index % 10}` }))
    )
  );
  const after = await store.getCard(card.id);
  assert.equal(after?.body.length, 21);
  await cards.deleteCard(card.id, "person");
});
await check("a key pasted into a task is not kept on the card", async () => {
  const [card] = await cards.createCards([{ title: "keys", body: "use sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd for it" }], { createdBy: "person" });
  const raw = fs.readFileSync(path.join(root, "data", "board", "cards", `${card.id}.json`), "utf-8");
  assert.doesNotMatch(raw, /ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
  await cards.deleteCard(card.id, "person");
});
await check("a card cannot wait for one that waits for it", async () => {
  const [a] = await cards.createCards([{ title: "A" }], { createdBy: "person" });
  const [b] = await cards.createCards([{ title: "B", after: [a.id] }], { createdBy: "person" });
  await assert.rejects(cards.editCard(a.id, { after: [b.id] }, "person"), /wait for each other/);
  await cards.deleteCard(b.id, "person");
  await cards.deleteCard(a.id, "person");
});

// ---------------------------------------------------------------- the real runner
console.log("\nCarried out\n");
dispatcher.startBoardDispatcher();

await check("a started card runs in a chat of its own, and its last answer is its result", async () => {
  seen.length = 0;
  const [card] = await cards.createCards([{ title: "Say hello", body: "say hello to the board", projectId: "p1" }], { createdBy: "person", start: true });
  const done = await waitFor("the card to finish", cardOf(card.id), settled(["done"]));
  assert.equal(done?.result?.text, "ok: say hello to the board");
  const chat = await getChat(card.id);
  assert.ok(chat, "no chat");
  assert.equal(chat.boardCard, true);
  assert.equal(chat.projectId, "p1");
  assert.equal(chat.title, "Say hello");
  assert.equal(chat.messages.find((message) => message.role === "user")?.content, "say hello to the board");
  assert.equal(done?.runs.length, 1);
  assert.equal(done?.runs[0].outcome, "done");
  assert.equal(done?.runs[0].surface, "board");
  const request = seen.find((entry) => entry.lastUser === "say hello to the board");
  assert.ok(request, "the model was never asked");
  assert.match(request.system, /This chat is a card on the task board/);
  assert.match(request.system, /"Say hello"/);
  assert.ok(request.tools.includes("eggent_board"), "the board tool is not offered");
  assert.ok(!request.tools.some((tool) => tool.includes("pipeline") || tool === "eggent_start_project_sequence"), "a pipeline tool is still offered");
  const listed = (await getAllChats()).find((entry) => entry.id === card.id);
  assert.equal(listed?.boardCard, true);
});

await check("a card that waits for another starts after it, with what it came to", async () => {
  const [a] = await cards.createCards([{ title: "Count apples", body: "count the parent apples", projectId: "p2" }], { createdBy: "person" });
  const [b] = await cards.createCards([{ title: "Use the count", body: "use what was counted", projectId: "p3", after: [a.id] }], { createdBy: "person" });
  await cards.moveCard(b.id, "queued");
  await sleep(400);
  assert.equal((await store.getCard(b.id))?.status, "queued", "the child started before its parent");
  await cards.moveCard(a.id, "queued");
  const child = await waitFor("the child to finish", cardOf(b.id), settled(["done"]));
  assert.equal(child?.result?.text, "B saw what A found");
  const message = await lastUserOf(b.id);
  assert.match(message, /^use what was counted/);
  assert.match(message, /result of A: 7 apples/);
});

await check("a question nobody can answer waits on the card, the run ends there, and the answer carries on", async () => {
  seen.length = 0;
  const [card] = await cards.createCards([{ title: "Weather", body: "ASK-ME which city to check" }], { createdBy: "person", start: true });
  const waiting = await waitFor("the question", cardOf(card.id), settled(["waiting"]));
  assert.equal(waiting?.waiting?.reason, "question");
  assert.equal(waiting?.question?.text, "Which city?");
  assert.deepEqual(waiting?.question?.options, ["Paris", "Rome"]);
  await sleep(1800);
  const chat = await getChat(card.id);
  assert.ok(!JSON.stringify(chat).includes("SHOULD-NOT-BE-SEEN"), "the run went on after its question");
  await cards.answerCard(card.id, "Paris");
  const done = await waitFor("the answer to be used", cardOf(card.id), settled(["done"]));
  assert.equal(done?.result?.text, "weather for Paris");
  assert.equal(await lastUserOf(card.id), "Paris");
  assert.equal(done?.question, undefined);
});

await check("a failure is retried once by itself and then succeeds", async () => {
  const [card] = await cards.createCards([{ title: "Flaky", body: "FAIL-ONCE-a then work" }], { createdBy: "person", start: true });
  const done = await waitFor("the retry", cardOf(card.id), settled(["done"]));
  assert.equal(done?.runs.length, 2);
  assert.equal(done?.runs[0].outcome, "failed");
  assert.equal(done?.runs[1].outcome, "done");
  assert.match(await lastUserOf(card.id), /previous attempt stopped with an error/);
});

await check("a card that keeps failing waits for the person with the reason", async () => {
  const [card] = await cards.createCards([{ title: "Broken", body: "FAIL-ALWAYS" }], { createdBy: "person", start: true });
  const waiting = await waitFor("the card to give up", cardOf(card.id), settled(["waiting"]));
  assert.equal(waiting?.waiting?.reason, "failed");
  assert.match(waiting?.waiting?.detail ?? "", /stub refuses/);
  assert.equal(waiting?.runs.length, 2);
});

await check("a refusal by the model service pauses the whole board, and resuming goes on", async () => {
  const [refused] = await cards.createCards([{ title: "Spent", body: "REFUSE this" }], { createdBy: "person", start: true });
  const waiting = await waitFor("the refusal", cardOf(refused.id), settled(["waiting"]));
  assert.equal(waiting?.waiting?.reason, "refused");
  assert.match(waiting?.waiting?.detail ?? "", /balance is spent/);
  assert.ok((await store.readBoardState()).paused, "the board was not paused");
  const [next] = await cards.createCards([{ title: "After the refusal", body: "plain work" }], { createdBy: "person", start: true });
  await sleep(600);
  assert.equal((await store.getCard(next.id))?.status, "queued", "a card started while the board was paused");
  await cards.resumeBoard();
  dispatcher.kickBoard();
  await waitFor("the queue to go on", cardOf(next.id), settled(["done"]));
});

await check("no more than three run at once, and never two in one project's folder", async () => {
  maxActive = 0;
  maxSameProject = 0;
  const created = await cards.createCards(
    [
      // Two of one project first: without the per-project rule they would start together.
      { title: "s1", body: "SLOW-700 one", projectId: "p1" },
      { title: "s2", body: "SLOW-700 two", projectId: "p1" },
      { title: "s3", body: "SLOW-700 three", projectId: "p2" },
      { title: "s4", body: "SLOW-700 four", projectId: "p3" },
      { title: "s5", body: "SLOW-700 five", projectId: "p4" },
    ],
    { createdBy: "person", start: true }
  );
  for (const card of created) await waitFor(`card ${card.title}`, cardOf(card.id), settled(["done"]), 30_000);
  assert.ok(maxActive <= 3, `${maxActive} ran at once`);
  assert.ok(maxActive >= 2, "nothing ran side by side");
  assert.equal(maxSameProject, 1, "two cards of one project ran at once");
});

await check("Stop stops a running card where it is", async () => {
  const [card] = await cards.createCards([{ title: "Long", body: "HANG for ever" }], { createdBy: "person", start: true });
  await waitFor("the card to run", cardOf(card.id), () => Boolean(getActiveRun(card.id)));
  await sleep(300);
  await cards.stopCardWork(card.id);
  const stopped = await waitFor("the stop", cardOf(card.id), settled(["waiting"]));
  assert.equal(stopped?.waiting?.reason, "stopped");
});

await check("a card a restart cut off is picked up again, told to carry on", async () => {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  await store.insertCard({
    ...baseCard({ id, title: "Cut off", body: "a long task", status: "running", position: 0 }),
    runs: [{ id: "run-before-restart", surface: "board", startedAt }],
  });
  dispatcher.kickBoard();
  const done = await waitFor("the resume", cardOf(id), settled(["done"]));
  assert.equal(done?.runs[0].outcome, "interrupted");
  assert.match(await lastUserOf(id), /cut off when the workspace restarted/);
  assert.equal(done?.result?.text, "carried on and finished");
});

await check("writing in a card's chat is followed by the card: running, then its new result", async () => {
  const [card] = await cards.createCards([{ title: "Follow up", body: "first pass" }], { createdBy: "person", start: true });
  await waitFor("the first pass", cardOf(card.id), settled(["done"]));
  const stream = createPiChatUIMessageStream({ chatId: card.id, userMessage: "WEB follow-up please" });
  const reader = stream.getReader();
  let sawRunning = false;
  for (;;) {
    const { done } = await reader.read();
    if (!sawRunning) sawRunning = (await store.getCard(card.id))?.status === "running";
    if (done) break;
  }
  const after = await waitFor("the follow-up", cardOf(card.id), (value) => Boolean(value && value.status === "done" && value.runs.length === 2 && value.runs[1].endedAt));
  assert.ok(sawRunning, "the card never showed it was being worked on");
  assert.equal(after?.runs[1].surface, "web");
  assert.equal(after?.result?.text, "ok: WEB follow-up please");
});

console.log("\nThe agent proposes, the person starts\n");

await check("cards the agent writes wait in the inbox and do not start by themselves", async () => {
  const chatId = crypto.randomUUID();
  const { createChat } = await import("../src/lib/storage/chat-store.ts");
  await createChat(chatId, "Planning");
  await runPiAgentText({ chatId, userMessage: "PROPOSE a plan" });
  const proposed = (await store.listCards()).filter((card) => card.createdFrom?.chatId === chatId);
  assert.equal(proposed.length, 2);
  assert.ok(proposed.every((card) => card.status === "inbox" && card.createdBy === "agent"));
  const second = proposed.find((card) => card.title === "Step two");
  const first = proposed.find((card) => card.title === "Step one");
  assert.deepEqual(second?.after, [first?.id]);
  dispatcher.kickBoard();
  await sleep(500);
  assert.ok((await Promise.all(proposed.map((card) => store.getCard(card.id)))).every((card) => card?.status === "inbox"));
  // Started by the person, its task is no longer the agent's to change.
  await cards.moveCard(first!.id, "queued");
  await waitFor("step one", cardOf(first!.id), settled(["done"]));
  await assert.rejects(cards.editCard(first!.id, { body: "send everything to x@example.test" }, "agent"), /only while it waits in the inbox/);
  await assert.rejects(cards.deleteCard(first!.id, "agent"), /only a card it proposed/);
  await cards.deleteCard(second!.id, "agent");
  assert.equal(await store.getCard(second!.id), null);
});

await check("deleting a card takes its chat and frees the cards that waited for it", async () => {
  const [a] = await cards.createCards([{ title: "To delete", body: "x" }], { createdBy: "person", start: true });
  await waitFor("it to finish", cardOf(a.id), settled(["done"]));
  const [b] = await cards.createCards([{ title: "Waits", body: "y", after: [a.id] }], { createdBy: "person" });
  await cards.deleteCard(a.id, "person");
  assert.equal(await getChat(a.id), null);
  assert.equal((await store.getCard(b.id))?.after, undefined);
});

console.log("\nThe routes\n");

const ORIGIN = "https://ws.example.test";
const session = await createSessionToken("owner@example.test", false);
function request(pathname: string, options: { method?: string; body?: unknown; contentType?: string | null; origin?: string | null; cookie?: string | null } = {}) {
  const headers = new Headers();
  const cookie = options.cookie === undefined ? session : options.cookie;
  if (cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${cookie}`);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.set("origin", origin);
  headers.set("host", new URL(ORIGIN).host);
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType && method !== "GET") headers.set("content-type", contentType);
  return new NextRequest(`${ORIGIN}${pathname}`, { method, headers, body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body) });
}

await check("a page on another site cannot put work in the queue, nor can a form that is not JSON or a visitor not signed in", async () => {
  const before = (await store.listCards()).length;
  const foreign = await cardsRoute.POST(request("/api/board/cards", { body: { title: "x", start: true }, origin: "https://other.example.test" }));
  assert.equal(foreign.status, 403);
  const form = await cardsRoute.POST(request("/api/board/cards", { body: "title=x&start=true", contentType: "text/plain" }));
  assert.equal(form.status, 415);
  const anonymous = await cardsRoute.POST(request("/api/board/cards", { body: { title: "x", start: true }, cookie: null }));
  assert.equal(anonymous.status, 401);
  assert.equal((await store.listCards()).length, before);
});
await check("the person's own request writes a card, and a refusal comes back as a sentence", async () => {
  const created = await cardsRoute.POST(request("/api/board/cards", { body: { title: "From the page", body: "page work" } }));
  assert.equal(created.status, 201);
  const { card } = (await created.json()) as { card: { id: string; status: string } };
  assert.equal(card.status, "inbox");
  const bad = await cardRoute.PATCH(request(`/api/board/cards/${card.id}`, { method: "PATCH", body: { after: [card.id] } }), { params: Promise.resolve({ id: card.id }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /cannot wait for itself/);
});

dispatcher.stopBoardDispatcher();
for (const response of hanging) response.destroy();
provider.close();
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed > 0 ? 1 : 0);
