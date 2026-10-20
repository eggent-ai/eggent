/**
 * A question nobody answers ends its turn after a day, and stays in the chat.
 *
 * Run with Node 22: npm run test:question-wait
 *
 * A turn waiting on a question is waiting, not stuck, so the watchdog never
 * stopped it - and on 2026-10-20 one had waited six days on a question nobody
 * was going to answer. It kept its workspace's turn running, so every fleet
 * roll passed the workspace by. The day is a second here. Runs the real chat
 * stream and session runtime against a local stub provider; no network, no
 * credential.
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
const BEFORE = "I read the wiring diagram.";
const QUESTION = "Which relay is it?";
const OPTION = "Finder 40.52";
const AFTER = "Then it switches at 230 V.";
const LATER = "It is the Finder one, sorry for the wait";
const LATER_REPLY = "Good, carrying on with the Finder relay.";
const WAIT_SECONDS = 2;

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** Every request the model received, as the text of its messages. */
const requests: string[] = [];
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
    requests.push(JSON.stringify(messages));
    const last = messages[messages.length - 1];
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    if (last?.role === "tool") {
      res.write(chunk({ content: AFTER }));
      res.write(chunk({}, "stop"));
    } else if (JSON.stringify(last?.content ?? "").includes(LATER)) {
      res.write(chunk({ content: LATER_REPLY }));
      res.write(chunk({}, "stop"));
    } else {
      res.write(chunk({ content: BEFORE }));
      res.write(chunk({
        tool_calls: [{
          index: 0,
          id: `stub-ask-${requests.length}`,
          type: "function",
          function: {
            name: "eggent_ask_user",
            arguments: JSON.stringify({ question: QUESTION, options: [OPTION, "Not sure"] }),
          },
        }],
      }));
      res.write(chunk({}, "tool_calls"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-question-wait-"));
process.chdir(root);
const agentDir = path.join(root, "data", "pi-agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
process.env.EGGENT_TURN_QUESTION_WAIT_SECONDS = String(WAIT_SECONDS);
process.env.EGGENT_TURN_WATCHDOG_TICK_MS = "100";
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
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, packages: [] }, null, 2));

const { createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { listPendingInteractions, respondToPendingInteraction } = await import("../src/lib/pi/pending-interactions.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { getActiveRun, stopActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { getLiveRun, whenLiveRunFinished } = await import("../src/lib/pi/live-run.ts");
const { createCards } = await import("../src/lib/board/cards.ts");
const { getCard } = await import("../src/lib/board/store.ts");

async function waitFor<T>(what: string, probe: () => Promise<T | null> | T | null, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Starts a web turn and returns the moment its stream has been read to the end. */
function turn(chatId: string, runId: string, userMessage: string): Promise<void> {
  const reader = createPiChatUIMessageStream({ chatId, userMessage, cwd, agentDir, runId }).getReader();
  return (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
}

/** The text of the result the model was given for the question, in the newest request that carries one. */
function questionResultSeenLast(): string {
  for (const request of [...requests].reverse()) {
    const messages = JSON.parse(request) as Array<{ role?: string; content?: unknown }>;
    const result = messages.find((message) => message.role === "tool");
    if (result) return JSON.stringify(result.content);
  }
  return "";
}

const assistantTurns = async (chatId: string) =>
  (await getChat(chatId))?.messages.filter((message) => message.role === "assistant") ?? [];

console.log("A question nobody answers\n");

const LEFT = "0000aaaa-2222-4333-8444-555566667777";
await createChat(LEFT, "Relay");
const askedAt = Date.now();
const left = turn(LEFT, "run-question-left", "Make a new project for the relay");
await waitFor("the question", () => listPendingInteractions("run-question-left")[0] ?? null);
const callsWhileAsking = requests.length;
const ended = await Promise.race([
  left.then(() => true),
  new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
]);
const waitedMs = Date.now() - askedAt;

await check("the turn ends by itself once the question has waited its time", () => {
  assert.equal(ended, true, "the turn was still waiting 20 s after a 2 s limit");
  assert.ok(waitedMs >= WAIT_SECONDS * 1000, `it ended after ${waitedMs} ms, before the question had waited its time`);
});
await check("the question is withdrawn and nothing is left running in the chat", () => {
  assert.equal(listPendingInteractions("run-question-left").filter((interaction) => interaction.status === "pending").length, 0);
  assert.equal(getActiveRun(LEFT), undefined);
  assert.equal(getLiveRun(LEFT), null);
});
await check("no word goes to the model after the question is withdrawn", () => {
  assert.equal(requests.length, callsWhileAsking, `${requests.length - callsWhileAsking} more request(s) after the question`);
});
await check("the stored chat keeps what was done, the question and its choices, and says why the turn ended", async () => {
  const turns = await assistantTurns(LEFT);
  assert.equal(turns.length, 1, `expected one stored turn, found ${turns.length}`);
  const [stored] = turns;
  assert.ok(!stored.inProgress, "the turn is still marked in progress");
  assert.ok(stored.content.includes(BEFORE), "what the turn did before the question was lost");
  assert.ok(stored.content.includes(QUESTION), "the question is gone from the chat");
  assert.ok(stored.content.includes(OPTION), "the choices the question offered are gone");
  assert.match(stored.content, /waited \d+ h without an answer/);
  assert.match(stored.content, /Answer it in this chat/);
});

await turn(LEFT, "run-question-later", LATER);

await check("an answer written later reaches the model, which was told nobody had answered rather than that the question was waved away", async () => {
  const seen = questionResultSeenLast();
  assert.match(seen, /Nobody answered this question/);
  assert.doesNotMatch(seen, /dismissed/);
  assert.ok(requests[requests.length - 1].includes(LATER), "the later answer did not reach the model");
  const turns = await assistantTurns(LEFT);
  assert.ok(turns[turns.length - 1]?.content.includes(LATER_REPLY), "the reply to the later answer was not stored");
});

console.log("\nOn a card\n");

// A card's chat is a chat like any other: a question asked in it while the person watched
// is a card in the chat, and nobody coming back to it for a day leaves the card waiting.
const [card] = await createCards([{ title: "Relay project", body: "Make a new project for the relay" }], { createdBy: "person" });
await turn(card.id, "run-question-card", "Make a new project for the relay");
const settledCard = await waitFor("the card to settle", async () => {
  const current = await getCard(card.id);
  return current && current.status !== "running" ? current : null;
}, 10_000).catch(() => null);

await check("a card whose question went unanswered waits on that question, on the board, where it can be answered", () => {
  assert.ok(settledCard, "the card still says it is running");
  assert.equal(settledCard.status, "waiting");
  assert.equal(settledCard.waiting?.reason, "question", `it waits as ${settledCard.waiting?.reason}`);
  assert.equal(settledCard.question?.text, QUESTION);
  assert.ok(settledCard.question?.options?.includes(OPTION), "the question's choices did not reach the card");
});

console.log("\nA question that is answered, or waved away\n");

const ANSWERED = "0000bbbb-2222-4333-8444-555566667777";
await createChat(ANSWERED, "Relay, answered");
const answered = turn(ANSWERED, "run-question-answered", "Make a new project for the relay");
const question = await waitFor("the second question", () => listPendingInteractions("run-question-answered")[0] ?? null);
await new Promise((resolve) => setTimeout(resolve, (WAIT_SECONDS * 1000) / 2));
respondToPendingInteraction("run-question-answered", question.id, { value: OPTION });
await answered;

await check("a question answered in time is not cut short", async () => {
  const turns = await assistantTurns(ANSWERED);
  assert.equal(turns.length, 1);
  assert.ok(turns[0].content.includes(AFTER), "the turn did not carry on after the answer");
  assert.doesNotMatch(turns[0].content, /without an answer/);
});

const WAVED = "0000cccc-2222-4333-8444-555566667777";
await createChat(WAVED, "Relay, stopped");
const waved = turn(WAVED, "run-question-waved", "Make a new project for the relay");
await waitFor("the third question", () => listPendingInteractions("run-question-waved")[0] ?? null);
const stopped = await stopActiveRun(WAVED);
if (stopped) await whenLiveRunFinished(WAVED);
await waved;
await turn(WAVED, "run-question-waved-later", LATER);

await check("a question the person stopped is still read as dismissed, not as unanswered", () => {
  assert.equal(stopped, true, "nothing was running to stop");
  const seen = questionResultSeenLast();
  assert.match(seen, /dismissed/);
  assert.doesNotMatch(seen, /Nobody answered/);
});

provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${ran} checks, ${failed} failed` : `\n${ran} checks, all passed`);
process.exit(failed ? 1 : 0);
