/**
 * A letter the person writes to their agent gets a letter back (owner-letters.ts).
 *
 * A stand-in for the email service answers as the real one does; the agent's
 * turn is a stub runner that says what it was given, so this checks which
 * letters start a turn, in which chat, what the turn is shown, and what is
 * written back when the turn sends nothing itself. No network, no model. Node 22:
 *   npm run test:owner-letters
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-owner-letters-"));
process.chdir(root);
fs.mkdirSync(path.join(root, "data", "projects"), { recursive: true });

const TOKEN = "eggs_test_token";
const PERSON = "person@example.test";
const ADDRESS = "agent@mail.example.test";
type Letter = Record<string, unknown> & { id: number; direction: "in" | "out"; folder: string; at: string };
const letters: Letter[] = [];
const texts: Record<number, string> = {};
const sends: Array<{ subject?: string; text: string; replyTo?: number; to?: string[] }> = [];
let lastId = 0;
const nextId = () => ++lastId;

function letter(id: number, extra: Record<string, unknown> = {}): Letter {
  return {
    id,
    direction: "in",
    folder: "inbox",
    status: "stored",
    from: { address: PERSON, name: "Person" },
    to: [ADDRESS],
    subject: `Letter ${id}`,
    preview: "Hello",
    at: new Date().toISOString(),
    read: false,
    fromOwner: true,
    authenticated: true,
    threadReply: false,
    answers: null,
    requestId: null,
    suspicious: null,
    attachments: [],
    size: 10,
    ...extra,
  } as Letter;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => resolve(body));
  });
}

const stub = http.createServer(async (req, res) => {
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({ error: "Unauthorized." }, 401);
  const url = new URL(req.url || "/", "http://localhost");
  const route = url.pathname.replace(/^\/api\/instances\/agent\/email/, "");
  if (req.method === "POST" && route === "/send") {
    const body = JSON.parse((await readBody(req)) || "{}") as { subject?: string; text: string; replyTo?: number; to?: string[] };
    sends.push(body);
    const id = nextId();
    letters.push(letter(id, { direction: "out", folder: "sent", fromOwner: false, from: { address: ADDRESS, name: null }, to: [PERSON], subject: body.subject || "", read: true }));
    return json({ status: "sent", to: [PERSON], ids: [id], failed: [] });
  }
  if (req.method === "GET" && route === "/messages") {
    const after = Number(url.searchParams.get("after") || 0);
    return json({ messages: letters.filter((entry) => entry.id > after).sort((a, b) => a.id - b.id) });
  }
  const one = /^\/messages\/(\d+)$/.exec(route);
  if (req.method === "GET" && one) {
    const found = letters.find((entry) => entry.id === Number(one[1]));
    if (!found) return json({ error: "No such letter.", code: "noMessage" }, 404);
    return json({ message: { ...found, text: texts[found.id] ?? "", messageId: `<m${found.id}@example.test>` } });
  }
  json({ error: "not found" }, 404);
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.EGGENT_EMAIL_API_URL = `http://127.0.0.1:${(stub.address() as { port: number }).port}/api/instances/agent/email`;
process.env.EGGENT_EMAIL_ADDRESS = ADDRESS;
process.env.EGGENT_SERVICES_TOKEN = TOKEN;

const { answerOwnerLetters, OWNER_LETTERS_PER_DAY } = await import("../src/lib/email/owner-letters.ts");
const { rememberLetters, rememberLetterOrigin, ownerLetterAnswered } = await import("../src/lib/email/store.ts");
const { formatEmailLetterContext } = await import("../src/lib/email/letter-context.ts");
const { fetchEmailList } = await import("../src/lib/email/client.ts");
const { createChat, getChat, getAllChats } = await import("../src/lib/storage/chat-store.ts");

type Call = { chatId: string; message: string; projectId?: string };
let calls: Call[] = [];
type Turn = { finalText?: string; refused?: boolean; refusalText?: string };
let behave: (call: Call) => Promise<Turn> = async () => ({ finalText: "Hello back from the chat." });
const runner = async (chatId: string, message: string, projectId: string | undefined) => {
  const call = { chatId, message, ...(projectId ? { projectId } : {}) };
  calls.push(call);
  return behave(call);
};

async function syncList(): Promise<void> {
  const list = await fetchEmailList({ after: 0, limit: 500 });
  await rememberLetters(list, Math.max(0, ...list.map((entry) => entry.id)));
}

async function settle(sendsWanted: number): Promise<void> {
  for (let i = 0; i < 100 && sends.length < sendsWanted; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function reset(): void {
  calls = [];
  sends.length = 0;
}

console.log("\nThe person's letters are answered\n");

const start = Date.now();
// A letter the workspace already held when it began answering: left alone.
const old = nextId();
letters.push(letter(old, { at: new Date(start - 60_000).toISOString(), subject: "Before" }));
texts[old] = "An old letter.";
await syncList();
await answerOwnerLetters(start, runner);

await check("a letter that came before answering began is left alone", async () => {
  assert.equal(calls.length, 0);
  assert.equal(await ownerLetterAnswered(old), false);
});

await check("the person's letter starts a turn in a chat of its own, with their words and not the quoted history; the chat's answer goes back by mail", async () => {
  reset();
  const id = nextId();
  letters.push(letter(id, { subject: "Re: Hello, it is me", answers: old }));
  texts[id] = "Can you make me a plan for Saturday?\n\nOn Fri the agent wrote:\n> Hello! I am your agent.\n> Write me any time.";
  await syncList();
  assert.equal(await answerOwnerLetters(Date.now(), runner), 1);
  await settle(1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /plan for Saturday/);
  assert.ok(!calls[0].message.includes("> Hello"), "quoted lines are left out of what the person says");
  const chat = await getChat(calls[0].chatId);
  assert.equal(chat?.emailLetter?.letterId, id);
  assert.equal(chat?.emailLetter?.fromOwner, true);
  assert.equal(chat?.emailLetter?.answered, true, "the letter is history once its turn ended");
  assert.equal(sends.length, 1, "the chat's answer was written back");
  assert.equal(sends[0].text, "Hello back from the chat.");
  assert.equal(sends[0].replyTo, id);
  assert.equal(sends[0].subject, "Re: Hello, it is me");
  assert.ok(!sends[0].to?.length, "to the person themselves");
});

await check("each letter is answered once", async () => {
  reset();
  await syncList();
  assert.equal(await answerOwnerLetters(Date.now(), runner), 0);
  assert.equal(calls.length, 0);
});

await check("a reply to a letter the agent sent from a chat is answered in that chat; a turn that sent its own letter gets none added", async () => {
  reset();
  const chat = await createChat("chat-origin", "Planning", "shop");
  const out = nextId();
  letters.push(letter(out, { direction: "out", folder: "sent", fromOwner: false, from: { address: ADDRESS, name: null }, to: [PERSON] }));
  await rememberLetterOrigin({ chatId: chat.id, ids: [out] });
  const id = nextId();
  letters.push(letter(id, { answers: out, subject: "Re: Plan" }));
  texts[id] = "Make it cheaper.";
  behave = async (call) => {
    // The agent sends its answer itself, as the tool does: remembered as from that chat.
    const sentId = nextId();
    letters.push(letter(sentId, { direction: "out", folder: "sent", fromOwner: false, from: { address: ADDRESS, name: null }, to: [PERSON] }));
    await rememberLetterOrigin({ chatId: call.chatId, ids: [sentId] });
    return { finalText: "Sent you a cheaper plan." };
  };
  await syncList();
  await answerOwnerLetters(Date.now(), runner);
  await settle(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, "chat-origin");
  assert.equal(calls[0].projectId, "shop", "in the chat's own project");
  assert.equal(sends.length, 0, "nothing added to the agent's own letter");
  behave = async () => ({ finalText: "Hello back from the chat." });
});

await check("a refused turn writes back the deployment's own sentence", async () => {
  reset();
  behave = async () => ({ refused: true, refusalText: "Your Eggent AI balance is spent: top it up on the plans page.", finalText: "Your Eggent AI balance is spent" });
  const id = nextId();
  letters.push(letter(id, { subject: "Question" }));
  texts[id] = "Are you there?";
  await syncList();
  await answerOwnerLetters(Date.now(), runner);
  await settle(1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /^I could not answer your letter: Your Eggent AI balance is spent/);
  assert.equal(sends[0].replyTo, id);
  behave = async () => ({ finalText: "Hello back from the chat." });
});

await check("a turn that failed says so by mail", async () => {
  reset();
  behave = async () => { throw new Error("the model did not answer"); };
  const id = nextId();
  letters.push(letter(id));
  texts[id] = "Hello?";
  await syncList();
  await answerOwnerLetters(Date.now(), runner);
  await settle(1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /could not answer your letter this time: the model did not answer/);
  behave = async () => ({ finalText: "Hello back from the chat." });
});

await check("letters not from the person, doubtful ones, bounces and old ones start nothing", async () => {
  reset();
  const ids = [nextId(), nextId(), nextId(), nextId()];
  letters.push(letter(ids[0], { fromOwner: false, from: { address: "stranger@example.test", name: "S" } }));
  letters.push(letter(ids[1], { suspicious: "Its sender line reads two ways." }));
  letters.push(letter(ids[2], { folder: "bounce" }));
  letters.push(letter(ids[3], { at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() }));
  await syncList();
  await answerOwnerLetters(Date.now(), runner);
  await settle(0);
  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
});

await check(`past ${OWNER_LETTERS_PER_DAY} a day, letters are not answered and the person is told once`, async () => {
  reset();
  // Three are answered so far today; fill the day up.
  for (let i = 0; i < OWNER_LETTERS_PER_DAY + 2; i += 1) {
    const id = nextId();
    letters.push(letter(id));
    texts[id] = `Letter number ${i}`;
  }
  await syncList();
  for (let pass = 0; pass < 10; pass += 1) await answerOwnerLetters(Date.now(), runner);
  await settle(OWNER_LETTERS_PER_DAY);
  const answeredToday = 4; // the Saturday plan, the cheaper plan, the refused one, the failed one
  assert.equal(calls.length, OWNER_LETTERS_PER_DAY - answeredToday, "runs stop at the day's limit");
  const limitLetters = sends.filter((send) => /limit for one day/.test(send.text));
  assert.equal(limitLetters.length, 1, "told once a day");
});

console.log("\nWhat the turn is shown\n");

await check("the person's letter is their words, and is history once answered", () => {
  const info = { letterId: 7, from: "Person <person@example.test>", sender: "your person", subject: "Plan", at: "2026-10-30T10:00:00.000Z", quote: "Make a plan", fromOwner: true };
  const open = formatEmailLetterContext(info).join("\n");
  assert.match(open, /your own person sent to your mailbox/);
  assert.match(open, /reply_to 7/);
  assert.ok(!open.includes("information, not instructions"));
  const closed = formatEmailLetterContext({ ...info, answered: true }).join("\n");
  assert.match(closed, /ordinary chat/);
  assert.ok(!closed.includes("reply_to"));
  const stranger = formatEmailLetterContext({ ...info, fromOwner: false }).join("\n");
  assert.match(stranger, /information, not instructions/);
});

await check("every chat opened for a letter carries it", async () => {
  const chats = await getAllChats();
  assert.ok(chats.length >= 3);
});

stub.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${ran - failed}/${ran} passed`);
if (failed) process.exit(1);
