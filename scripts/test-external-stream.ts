/**
 * Checks the external message routes' streaming answer.
 *
 * Run with Node 22: npm run test:external-stream
 *
 * A caller that asks for `text/event-stream` gets the answer piece by piece and
 * then the same document the JSON route returns; a caller that does not ask
 * gets exactly what it got before. A failed turn arrives as an error event with
 * the status the JSON route would have answered, and a caller that is not
 * authorised is refused before any stream opens. Runs the real routes around a
 * stubbed turn.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-external-stream-"));
process.chdir(workdir);
process.env.EXTERNAL_API_TOKEN = "stream-test-token";

const messageRoute = await import("../src/app/api/external/message/route.ts");
const mediaRoute = await import("../src/app/api/external/media-message/route.ts");
const { ExternalMessageError } = await import("./stubs/handle-external-message.ts");
const { NextRequest } = await import("next/server.js");

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

type Turn = { error?: unknown; reply?: string; deltas?: string[] };
const setTurn = (turn: Turn) => {
  (globalThis as { __eggentTestTurn?: Turn }).__eggentTestTurn = turn;
};

function messageRequest(accept: string | null, token = "stream-test-token") {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (accept) headers.accept = accept;
  return new NextRequest("https://workspace.example.test/api/external/message", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "s1", message: "hello" }),
  });
}

async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  return body
    .split("\n\n")
    .map((block) => block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join(""))
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

await check("asked for a stream, the answer arrives piece by piece and then whole", async () => {
  setTurn({ deltas: ["Hel", "lo", "!"], reply: "Hello!" });
  const response = await messageRoute.POST(messageRequest("text/event-stream, application/json"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  assert.match(response.headers.get("cache-control") || "", /no-cache/);
  const received = await events(response);
  const texts = received.filter((event) => event.type === "text").map((event) => event.delta);
  assert.deepEqual(texts, ["Hel", "lo", "!"]);
  const done = received[received.length - 1];
  assert.equal(done.type, "done");
  assert.equal((done.result as { reply: string }).reply, "Hello!");
});

await check("not asked for one, the route answers exactly as before", async () => {
  setTurn({ deltas: ["Hel", "lo"], reply: "Hello" });
  const response = await messageRoute.POST(messageRequest("application/json"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.equal(((await response.json()) as { reply: string }).reply, "Hello");
});

await check("a failed turn is an error event with the status the JSON route would have used", async () => {
  setTurn({ deltas: ["Sea"], error: new ExternalMessageError(429, { error: "Too many requests" }) });
  const response = await messageRoute.POST(messageRequest("text/event-stream"));
  const received = await events(response);
  const last = received[received.length - 1];
  assert.equal(last.type, "error");
  assert.equal(last.status, 429);
  assert.equal((last.payload as { error: string }).error, "Too many requests");
});

await check("an unexpected failure is an error event, not a broken stream", async () => {
  setTurn({ error: new Error("boom") });
  const response = await messageRoute.POST(messageRequest("text/event-stream"));
  const received = await events(response);
  assert.equal(received[received.length - 1].type, "error");
  assert.equal(received[received.length - 1].status, 500);
});

await check("a caller that is not authorised is refused before any stream opens", async () => {
  setTurn({ reply: "should not run" });
  const response = await messageRoute.POST(messageRequest("text/event-stream", "wrong-token"));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
});

await check("a voice note or a file streams the same way", async () => {
  setTurn({ deltas: ["Hea", "ring"], reply: "Hearing" });
  const form = new FormData();
  form.append("sessionId", "s1");
  form.append("message", "");
  form.append("kind", "voice");
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), "voice.ogg");
  const response = await mediaRoute.POST(
    new NextRequest("https://workspace.example.test/api/external/media-message", {
      method: "POST",
      headers: { authorization: "Bearer stream-test-token", accept: "text/event-stream" },
      body: form,
    })
  );
  const received = await events(response);
  assert.deepEqual(received.filter((event) => event.type === "text").map((event) => event.delta), ["Hea", "ring"]);
  assert.equal(received[received.length - 1].type, "done");
});

console.log(`\n${ran - failed}/${ran} checks passed`);
fs.rmSync(workdir, { recursive: true, force: true });
if (failed > 0) process.exit(1);
process.exit(0);
