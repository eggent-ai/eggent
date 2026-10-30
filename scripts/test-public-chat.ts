/**
 * A project's public link, served by the workspace: who a visitor is, and
 * which conversations they may see.
 *
 * A stand-in for the hosting service says which links are open and records the
 * codes it is asked to mail; a stand-in model answers. The link's routes are
 * driven through the real code: an address typed for the first time gives that
 * browser a key; the same address from another browser gets nothing without
 * the code from the letter, and proving it takes the key away from a browser
 * that never proved it; one visitor never reaches another's conversation; a
 * form posted from another site is refused; a visitor asks no more than the
 * link allows.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:public-chat
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

const TOKEN = "eggw_public_chat_token";
const LINK = "LinkLinkLinkLinkLinkLink01";
const CLOSED = "ClosedClosedClosedClosed01";
const codes: Array<{ email: string; code: string; locale: string }> = [];
let mailRefuses = false;

const service = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => { body += part; });
  req.on("end", () => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "Unauthorized." });
    if (req.url === `/api/public-chat/shares/${LINK}`) {
      return json(200, { share: { token: LINK, projectId: "survey", title: "Survey", welcome: "Hello there", maxMessagesPerHour: 2 } });
    }
    if (req.url === `/api/public-chat/shares/${LINK}/code` && req.method === "POST") {
      if (mailRefuses) return json(429, { error: "Too many." });
      codes.push(JSON.parse(body));
      return json(200, { sent: true });
    }
    json(404, { error: "Not found." });
  });
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const serviceUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}/api/public-chat`;

const MODEL = "stub-model";
const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  req.resume();
  req.on("end", () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "Answer from the stub." }));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-public-chat-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: { stub: { name: "Stub", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, api: "openai-completions", models: [{ id: MODEL, name: "Stub", input: ["text"], contextWindow: 16384, maxTokens: 2048 }] } },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ stub: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: MODEL }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
process.env.EGGENT_USAGE_API_TOKEN = TOKEN;
process.env.EGGENT_PUBLIC_CHAT_API_URL = serviceUrl;

const { createProject } = await import("../src/lib/storage/project-store.ts");
await createProject({ id: "survey", memoryMode: "isolated", name: "Survey", description: "A questionnaire", instructions: "Ask three questions." });
const { addConversation } = await import("../src/lib/public-chat/visitors.ts");
const infoRoute = await import("../src/app/s/[token]/api/route.ts");
const visitorRoute = await import("../src/app/s/[token]/api/visitor/route.ts");
const verifyRoute = await import("../src/app/s/[token]/api/verify/route.ts");
const forgetRoute = await import("../src/app/s/[token]/api/forget/route.ts");
const messageRoute = await import("../src/app/s/[token]/api/message/route.ts");
const chatRoute = await import("../src/app/s/[token]/api/chats/[conversation]/route.ts");
const stopRoute = await import("../src/app/s/[token]/api/stop/route.ts");
const answerRoute = await import("../src/app/s/[token]/api/answer/route.ts");
const transcribeRoute = await import("../src/app/s/[token]/api/transcribe/route.ts");

const ORIGIN = "https://owner.example.test";
/** A browser: the cookie jar of one visitor's device. */
function browser(ip: string) {
  let cookie = "";
  const request = (url: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) => new NextRequest(`${ORIGIN}${url}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      host: "owner.example.test",
      "x-forwarded-proto": "https",
      "x-forwarded-for": ip,
      ...(init.method === "POST" && init.origin !== null ? { origin: init.origin ?? ORIGIN } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const keep = (response: Response) => {
    const set = response.headers.get("set-cookie");
    if (set) {
      const value = set.split(";")[0];
      cookie = value.endsWith("=") ? "" : value;
    }
    return response;
  };
  return {
    request,
    keep,
    get cookie() { return cookie; },
    set cookie(value: string) { cookie = value; },
  };
}
const p = (token: string, extra: { conversation?: string } = {}) => ({ params: Promise.resolve({ token, conversation: extra.conversation ?? "" }) });
const info = async (b: ReturnType<typeof browser>, token = LINK) => (await infoRoute.GET(b.request(`/s/${token}/api`), p(token))).json();
const start = async (b: ReturnType<typeof browser>, name: string, email: string) =>
  b.keep(await visitorRoute.POST(b.request(`/s/${LINK}/api/visitor`, { method: "POST", body: { name, email } }), p(LINK)));
const verify = async (b: ReturnType<typeof browser>, email: string, code: string) =>
  b.keep(await verifyRoute.POST(b.request(`/s/${LINK}/api/verify`, { method: "POST", body: { email, code } }), p(LINK)));

const laptop = browser("10.0.0.1");
const phone = browser("10.0.0.2");
const stranger = browser("10.0.0.3");

console.log("A link and who is writing\n");

await check("a link the service does not know is not open, and says nothing more", async () => {
  const response = await infoRoute.GET(laptop.request(`/s/${CLOSED}/api`), p(CLOSED));
  assert.equal(response.status, 404);
  assert.equal((await visitorRoute.POST(laptop.request(`/s/${CLOSED}/api/visitor`, { method: "POST", body: { name: "A", email: "a@example.test" } }), p(CLOSED))).status, 404);
});
await check("an open link shows its name and asks who is writing", async () => {
  const data = await info(laptop);
  assert.equal(data.share.title, "Survey");
  assert.equal(data.visitor, null);
  assert.equal(data.mail, true);
});
await check("nothing can be asked before a name and an email", async () => {
  const response = await messageRoute.POST(laptop.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "hi" } }), p(LINK));
  assert.equal(response.status, 401);
});
await check("an address seen for the first time gives this browser a key, kept to the link's own addresses", async () => {
  const response = await start(laptop, "Anna", "Anna@Example.test");
  assert.equal(response.status, 200);
  const set = response.headers.get("set-cookie") || "";
  assert.match(set, /HttpOnly/);
  assert.match(set, new RegExp(`Path=/s/${LINK}`));
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Secure/);
  const data = await info(laptop);
  assert.deepEqual(data.visitor, { name: "Anna", email: "anna@example.test", confirmed: false });
  assert.equal(codes.length, 0, "no letter for an address seen for the first time");
});
await check("the key is stored only as its hash", async () => {
  const stored = fs.readFileSync(path.join(root, "data", "public-visitors", `${LINK}.json`), "utf-8");
  const key = laptop.cookie.split("=")[1].split(".")[1];
  assert.ok(key.length > 20);
  assert.ok(!stored.includes(key));
});
await check("a form posted from another site is refused, the visitor's cookie notwithstanding", async () => {
  const foreign = await messageRoute.POST(laptop.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "hi" }, origin: "https://other.example.test" }), p(LINK));
  assert.equal(foreign.status, 403);
  const bare = await messageRoute.POST(laptop.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "hi" }, origin: null }), p(LINK));
  assert.equal(bare.status, 403);
});

console.log("\nAn answer, and the conversation it belongs to\n");

let annaConversation = "";
await check("a visitor's message is answered as the chat's own stream, naming the new conversation", async () => {
  const response = await messageRoute.POST(laptop.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "What is this?" } }), p(LINK));
  assert.equal(response.status, 200);
  annaConversation = response.headers.get("x-eggent-conversation") || "";
  assert.match(annaConversation, /^[a-f0-9]{16}$/);
  const text = await response.text();
  assert.match(text, /"type":"text-delta"/);
  assert.match(text, /Answer from the stub/);
  assert.doesNotMatch(text, /data-piStats/);
});
await check("the link's first message opens the conversation as the project's, before the visitor's", async () => {
  const chat = await (await chatRoute.GET(laptop.request("/x"), p(LINK, { conversation: annaConversation }))).json();
  const [first, second] = chat.chat.messages;
  assert.equal(first.role, "assistant");
  assert.equal(first.content, "Hello there");
  assert.equal(first.opening, true);
  assert.equal(second.role, "user");
});
await check("after a refresh the same browser finds its conversation", async () => {
  const data = await info(laptop);
  assert.equal(data.conversations[0].id, annaConversation);
  assert.equal(data.conversations[0].title, "What is this?");
  const chat = await (await chatRoute.GET(laptop.request("/x"), p(LINK, { conversation: annaConversation }))).json();
  assert.equal(chat.chat.messages.filter((message: { role: string }) => message.role === "user")[0].content, "What is this?");
  assert.ok(chat.chat.messages.every((message: Record<string, unknown>) => message.piRuntimeStats === undefined));
});
await check("a visitor asks no more than the link allows in an hour", async () => {
  const second = await messageRoute.POST(laptop.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "And?", conversation: annaConversation } }), p(LINK));
  assert.equal(second.status, 200);
  await second.text();
  const chat = await (await chatRoute.GET(laptop.request("/x"), p(LINK, { conversation: annaConversation }))).json();
  assert.equal(chat.chat.messages.filter((message: { opening?: boolean }) => message.opening).length, 1, "the opening was written twice");
  const third = await messageRoute.POST(laptop.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "More?", conversation: annaConversation } }), p(LINK));
  assert.equal(third.status, 429);
});

console.log("\nThe same address from another browser\n");

await check("another browser typing the address gets no conversation, and a code goes to the address", async () => {
  const response = await start(phone, "Not Anna", "anna@example.test");
  const data = await response.json();
  assert.equal(data.needsCode, true);
  assert.equal(data.email, "a***@example.test");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await info(phone)).visitor, null);
  assert.equal(codes.at(-1)?.email, "anna@example.test");
  assert.match(codes.at(-1)?.code || "", /^\d{6}$/);
});
await check("asking again within the minute sends no second letter", async () => {
  const before = codes.length;
  await start(phone, "Not Anna", "anna@example.test");
  assert.equal(codes.length, before);
});
await check("a wrong code opens nothing, and five end the code", async () => {
  const right = codes.at(-1)!.code;
  const wrong = right === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i += 1) assert.equal((await verify(phone, "anna@example.test", wrong)).status, 400);
  const fifth = await verify(phone, "anna@example.test", wrong);
  assert.equal((await fifth.json()).code, "codeExpired");
  assert.equal((await verify(phone, "anna@example.test", right)).status, 410, "the right code after five wrong ones");
  assert.equal((await info(phone)).visitor, null);
});
await check("the code from the letter opens the conversations, and the browser that never proved the address loses them", async () => {
  // A minute later: a new code may be sent.
  const { default: fsp } = await import("node:fs/promises");
  const file = path.join(root, "data", "public-visitors", `${LINK}.json`);
  const stored = JSON.parse(await fsp.readFile(file, "utf-8"));
  for (const visitor of Object.values(stored.visitors) as Array<{ code?: { sentAt: string } }>) if (visitor.code) visitor.code.sentAt = "2000-01-01T00:00:00.000Z";
  await fsp.writeFile(file, JSON.stringify(stored));
  await start(phone, "Anna", "anna@example.test");
  const response = await verify(phone, "anna@example.test", codes.at(-1)!.code);
  assert.equal(response.status, 200);
  const data = await info(phone);
  assert.equal(data.visitor.confirmed, true);
  assert.equal(data.conversations[0].id, annaConversation);
  assert.equal((await info(laptop)).visitor, null, "the browser that typed the address unproved still holds it");
});
await check("once proved, another browser needs a code again and the proved one keeps its key", async () => {
  const response = await start(stranger, "Mallory", "anna@example.test");
  assert.equal((await response.json()).needsCode, true);
  assert.equal((await info(stranger)).visitor, null);
  assert.equal((await info(phone)).visitor.email, "anna@example.test");
});

console.log("\nOne visitor, never another's conversation\n");

const bob = browser("10.0.0.4");
await check("a second visitor sees none of the first's conversations, by list or by id", async () => {
  await start(bob, "Bob", "bob@example.test");
  assert.deepEqual((await info(bob)).conversations, []);
  assert.equal((await chatRoute.GET(bob.request("/x"), p(LINK, { conversation: annaConversation }))).status, 404);
  const asked = await messageRoute.POST(bob.request(`/s/${LINK}/api/message`, { method: "POST", body: { message: "hi", conversation: annaConversation } }), p(LINK));
  assert.equal(asked.status, 404);
  assert.equal((await stopRoute.POST(bob.request(`/s/${LINK}/api/stop`, { method: "POST", body: { conversation: annaConversation } }), p(LINK))).status, 404);
  assert.equal((await answerRoute.POST(bob.request(`/s/${LINK}/api/answer`, { method: "POST", body: { conversation: annaConversation, interactionId: "x", value: "y" } }), p(LINK))).status, 404);
});
await check("a cookie with a made-up key is nobody", async () => {
  const forged = browser("10.0.0.5");
  const id = phone.cookie.split("=")[1].split(".")[0];
  forged.cookie = `eggent_visitor=${id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assert.equal((await info(forged)).visitor, null);
});
await check("voice needs a visitor, and a recording that is too long is refused before it is read", async () => {
  const nobody = browser("10.0.0.6");
  assert.equal((await transcribeRoute.POST(nobody.request(`/s/${LINK}/api/transcribe`, { method: "POST", body: {} }), p(LINK))).status, 401);
  const big = new NextRequest(`${ORIGIN}/s/${LINK}/api/transcribe`, {
    method: "POST",
    headers: { host: "owner.example.test", "x-forwarded-proto": "https", origin: ORIGIN, cookie: bob.cookie, "content-length": String(20 * 1024 * 1024) },
    body: "x",
  });
  assert.equal((await transcribeRoute.POST(big, p(LINK))).status, 413);
});
await check("\"not you?\" lets the browser go of the visitor", async () => {
  bob.keep(await forgetRoute.POST(bob.request(`/s/${LINK}/api/forget`, { method: "POST", body: {} }), p(LINK)));
  assert.equal((await info(bob)).visitor, null);
});
await check("a visitor has no more conversations than allowed", async () => {
  const carol = browser("10.0.0.7");
  await start(carol, "Carol", "carol@example.test");
  const id = carol.cookie.split("=")[1].split(".")[0];
  let added = 0;
  for (let i = 0; i < 205; i += 1) if (await addConversation(LINK, id, i.toString(16).padStart(16, "0"))) added += 1;
  assert.equal(added, 200);
});

console.log("\nWithout the mail\n");

await check("a code the service will not send leaves no code waiting and says why", async () => {
  mailRefuses = true;
  const dave = browser("10.0.0.8");
  await start(dave, "Dave", "dave@example.test");
  const other = browser("10.0.0.9");
  const response = await start(other, "Dave", "dave@example.test");
  assert.equal(response.status, 429);
  mailRefuses = false;
});

service.close();
provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
