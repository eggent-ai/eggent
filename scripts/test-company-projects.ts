/**
 * Projects a company opened to its people, from a person's workspace.
 *
 * A stand-in for the company's service answers the way the real one does and
 * records what it was sent. The routes the page and the sidebar call are
 * driven through the real code: nothing exists without the address, every
 * route wants a signed-in session from this workspace's own pages, ids that
 * are not ids never reach the service, and the answer streams through as the
 * project's workspace wrote it, with the conversation it went into.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:company-projects
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-company-projects-"));
process.chdir(root);
fs.mkdirSync(path.join(root, "data"), { recursive: true });

const TOKEN = "eggw_test_token";
const PROJECT = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const CONVERSATION = "0123456789abcdef";
const seen: Array<{ method: string; url: string; auth: string; accept: string; body: string }> = [];
const service = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    seen.push({ method: req.method || "", url: req.url || "", auth: String(req.headers.authorization || ""), accept: String(req.headers.accept || ""), body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "Unauthorized.", code: "unauthorized" });
    if (req.url === "/api/company-projects") {
      return json(200, { projects: [{ id: PROJECT, projectId: "kb", title: "Knowledge base", welcome: null, from: "ACME", company: "ACME" }] });
    }
    if (req.url === `/api/company-projects/${PROJECT}/chats`) return json(200, { chats: [{ id: CONVERSATION, title: "Leave", updatedAt: "", messages: 2 }] });
    if (req.url === `/api/company-projects/${PROJECT}/chats/${CONVERSATION}?full=1`) {
      return json(200, { chat: { id: CONVERSATION, title: "Leave", running: false, messages: [{ id: "1", role: "user", content: "Leave?", createdAt: "" }] } });
    }
    if (req.url === `/api/company-projects/${PROJECT}/chats/${CONVERSATION}/stream`) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === `/api/company-projects/${PROJECT}/stop`) return json(200, { stopped: true });
    if (req.url === `/api/company-projects/${PROJECT}/answer`) return json(200, { answered: true });
    if (req.url === `/api/company-projects/${PROJECT}/message`) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Eggent-Conversation": CONVERSATION });
      res.write(`data: ${JSON.stringify({ type: "text-start", id: "t" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "text-delta", id: "t", delta: "Twenty days." })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: "finish" })}\n\n`);
      return;
    }
    json(404, { error: "This project is not open to you.", code: "notShared" });
  });
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const serviceUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}/api/company-projects`;

delete process.env.EGGENT_COMPANY_PROJECTS_API_URL;
process.env.EGGENT_USAGE_API_TOKEN = TOKEN;

const { createSessionToken } = await import("../src/lib/auth/session.ts");
const listRoute = await import("../src/app/api/company-projects/route.ts");
const chatsRoute = await import("../src/app/api/company-projects/[id]/chats/route.ts");
const chatRoute = await import("../src/app/api/company-projects/[id]/chats/[conversation]/route.ts");
const messageRoute = await import("../src/app/api/company-projects/[id]/message/route.ts");
const streamRoute = await import("../src/app/api/company-projects/[id]/chats/[conversation]/stream/route.ts");
const stopRoute = await import("../src/app/api/company-projects/[id]/stop/route.ts");
const answerRoute = await import("../src/app/api/company-projects/[id]/answer/route.ts");
const { isReservedDashboardSegment } = await import("../src/lib/dashboard-routes.ts");

const session = await createSessionToken("tester", false);
const request = (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: boolean } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      ...(init.cookie === false ? {} : { cookie: `eggent_auth=${session}` }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

console.log("Without the address\n");

await check("nothing exists: the list says so and asks nobody", async () => {
  const response = await listRoute.GET(request("/api/company-projects"));
  assert.deepEqual(await response.json(), { enabled: false });
  assert.equal(seen.length, 0);
});
await check("the page's address can never be taken for a chat", () => {
  assert.equal(isReservedDashboardSegment("company"), true);
});

process.env.EGGENT_COMPANY_PROJECTS_API_URL = serviceUrl;
console.log("\nWith it\n");

await check("the list comes from the service, asked with the workspace's own token", async () => {
  const data = await (await listRoute.GET(request("/api/company-projects"))).json();
  assert.equal(data.enabled, true);
  assert.equal(data.projects[0].title, "Knowledge base");
  assert.equal(seen.at(-1)?.auth, `Bearer ${TOKEN}`);
});
await check("every route wants a session, and a question wants this workspace's own page", async () => {
  assert.equal((await listRoute.GET(request("/api/company-projects", { cookie: false }))).status, 401);
  assert.equal((await chatsRoute.GET(request(`/api/company-projects/${PROJECT}/chats`, { cookie: false }), params({ id: PROJECT }))).status, 401);
  const foreign = await messageRoute.POST(
    request(`/api/company-projects/${PROJECT}/message`, { method: "POST", body: { message: "hi" }, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" } }),
    params({ id: PROJECT })
  );
  assert.equal(foreign.status, 403);
});
await check("ids that are not ids never reach the service", async () => {
  const before = seen.length;
  assert.equal((await chatsRoute.GET(request("/api/company-projects/x/chats"), params({ id: "../../etc" }))).status, 404);
  assert.equal((await chatRoute.GET(request("/x"), params({ id: PROJECT, conversation: "../settings" }))).status, 404);
  assert.equal((await messageRoute.POST(request("/x", { method: "POST", body: { message: "hi", conversation: "nope!" } }), params({ id: PROJECT }))).status, 404);
  assert.equal((await messageRoute.POST(request("/x", { method: "POST", body: { message: "   " } }), params({ id: PROJECT }))).status, 400);
  assert.equal(seen.length, before);
});
await check("conversations are listed and read through", async () => {
  const list = await (await chatsRoute.GET(request("/x"), params({ id: PROJECT }))).json();
  assert.equal(list.chats[0].id, CONVERSATION);
  const one = await (await chatRoute.GET(request("/x"), params({ id: PROJECT, conversation: CONVERSATION }))).json();
  // Whole, as the chat draws it: the stored message, and whether a turn works in it.
  assert.equal(one.chat.messages[0].content, "Leave?");
  assert.equal(one.chat.running, false);
});
await check("a conversation with no turn working answers 204 to the screen that would attach to it", async () => {
  const response = await streamRoute.GET(request("/x"), params({ id: PROJECT, conversation: CONVERSATION }));
  assert.equal(response.status, 204);
  assert.equal((await streamRoute.GET(request("/x"), params({ id: PROJECT, conversation: "../x" }))).status, 404);
});
await check("stop and a card's answer go through for one conversation, from this workspace's own page only", async () => {
  const stopped = await stopRoute.POST(request("/x", { method: "POST", body: { conversation: CONVERSATION } }), params({ id: PROJECT }));
  assert.deepEqual(await stopped.json(), { stopped: true });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { conversation: CONVERSATION });
  const answered = await answerRoute.POST(
    request("/x", { method: "POST", body: { conversation: CONVERSATION, interactionId: "q1", value: "Yes", extra: "ignored" } }),
    params({ id: PROJECT })
  );
  assert.deepEqual(await answered.json(), { answered: true });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { conversation: CONVERSATION, interactionId: "q1", value: "Yes", cancel: false });
  const before = seen.length;
  assert.equal((await answerRoute.POST(request("/x", { method: "POST", body: { conversation: "nope!" } }), params({ id: PROJECT }))).status, 404);
  const foreign = await stopRoute.POST(
    request("/x", { method: "POST", body: { conversation: CONVERSATION }, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" } }),
    params({ id: PROJECT })
  );
  assert.equal(foreign.status, 403);
  assert.equal(seen.length, before);
});
await check("a question's answer streams through, naming the conversation it went into", async () => {
  const response = await messageRoute.POST(request("/x", { method: "POST", body: { message: "How much leave?" } }), params({ id: PROJECT }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(response.headers.get("x-eggent-conversation"), CONVERSATION);
  const text = await response.text();
  assert.match(text, /"type":"text-delta"/);
  const sent = seen.at(-1)!;
  assert.match(sent.accept, /text\/event-stream/);
  // The workspace chat's own stream is asked for, so cards and tools come through.
  assert.deepEqual(JSON.parse(sent.body), { message: "How much leave?", format: "ui" });
});
await check("a project the service does not open answers with its refusal", async () => {
  const response = await chatsRoute.GET(request("/x"), params({ id: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "notShared");
});
await check("a service that does not answer leaves the sidebar empty, not broken", async () => {
  process.env.EGGENT_COMPANY_PROJECTS_API_URL = "http://127.0.0.1:9/api/company-projects";
  const data = await (await listRoute.GET(request("/api/company-projects"))).json();
  assert.deepEqual(data, { enabled: true, projects: [] });
  process.env.EGGENT_COMPANY_PROJECTS_API_URL = serviceUrl;
});

service.close();
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
