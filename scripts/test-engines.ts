/**
 * A project set to run on an engine - a program on the person's own computer -
 * has that program do its turns, and everything around a turn still works.
 *
 * Drives the real runners and the real SDK with a fake engine standing in for
 * the program, and a stub model that fails the test if it is ever asked: the
 * stand-in model must not reach a network. What is checked is what a person
 * would otherwise find out: the words arrive unchanged, the program works in
 * the project's folder with its instructions, the next message continues its
 * session, a chat that began elsewhere is told what was said, a lost session
 * starts over, Stop reaches the program, a program that cannot start says why
 * in the chat, the choice stays on this computer, and a project without one is
 * untouched.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:engines
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A model that answers plainly, for the project that is not on an engine.
let modelCalls = 0;
const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
    return;
  }
  req.resume();
  req.on("end", () => {
    modelCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "from the model" }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-engines-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    stub: {
      name: "Stub",
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      api: "openai-completions",
      models: [{ id: "stub-model", name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
    },
  },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ stub: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-model" }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";

const projectStore = await import("../src/lib/storage/project-store.ts");
const { runPiAgentText, createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat, saveChat } = await import("../src/lib/storage/chat-store.ts");
const { stopActiveRun } = await import("../src/lib/pi/active-runs.ts");
const registry = await import("../src/lib/engines/registry.ts");
const store = await import("../src/lib/engines/store.ts");
const { buildEngineRecap } = await import("../src/lib/engines/brief.ts");
const limits = await import("../src/lib/engines/limits.ts");

import type { Engine, EngineRunRequest, EngineRunResult } from "../src/lib/engines/host-types.ts";
import type { EngineStatus } from "../src/lib/engines/types.ts";

fs.mkdirSync(path.join(root, "data", "projects", "skills"), { recursive: true });
await projectStore.createProject({ id: "p1", name: "Proj One", description: "Work with files", instructions: "P1-MARKER: keep notes in notes.md.", memoryMode: "isolated" } as never);
await projectStore.createProject({ id: "p2", name: "Proj Two", description: "Plain", instructions: "P2-MARKER", memoryMode: "isolated" } as never);

// The fake program.
const requests: EngineRunRequest[] = [];
let status: EngineStatus = { state: "ready", version: "1.0.0", account: "Max" };
let lostOnce = false;
const fake: Engine = {
  id: "fake",
  label: "Fake Code",
  models: () => [{ id: "", label: "Default" }, { id: "fast", label: "Fast" }],
  status: async () => status,
  startLogin: async () => ({ done: Promise.resolve(status), cancel: () => {} }),
  run: async (request): Promise<EngineRunResult> => {
    requests.push(request);
    if (request.prompt.includes("LOST") && request.sessionId && !lostOnce) {
      lostOnce = true;
      return { ok: false, text: "", error: { code: "session-lost", message: "No conversation found" } };
    }
    if (request.prompt.includes("LIMIT")) {
      return { ok: false, text: "", error: { code: "limit", message: "5-hour limit" }, resetsAt: 1_900_000_000 };
    }
    if (request.prompt.includes("SLOW")) {
      request.onEvent({ type: "step", id: "s1", tool: "Bash", target: "sleep 30", phase: "start" });
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: false, stopped: true, text: "" };
    }
    request.onEvent({ type: "session", sessionId: request.sessionId ?? "sess-1" });
    request.onEvent({ type: "step", id: "s1", tool: "Read", target: "README.md", phase: "start" });
    request.onEvent({ type: "step", id: "s1", tool: "Read", phase: "end" });
    request.onEvent({ type: "text", text: `fake: ${request.prompt}` });
    return { ok: true, text: `fake: ${request.prompt}`, sessionId: request.sessionId ?? "sess-1", toolUses: 1 };
  },
};
registry.registerEngine(fake);
await store.writeEngineChoice("p1", { engine: "fake", model: "", access: "project", consentAt: new Date().toISOString() });

let chatNumber = 0;
async function newChat(title: string, projectId?: string): Promise<string> {
  chatNumber += 1;
  const id = `${String(chatNumber).padStart(8, "0")}-0000-4000-8000-000000000000`;
  await createChat(id, title, projectId);
  return id;
}

console.log("A turn on an engine\n");

const first = await newChat("First", "p1");
const events: Array<Record<string, unknown>> = [];
const firstReply = await runPiAgentText({
  chatId: first,
  projectId: "p1",
  userMessage: "@p2 how many files are here?",
  onSessionEvent: (event) => events.push(event as Record<string, unknown>),
});

await check("the program's answer is the chat's answer, and no model was asked", () => {
  assert.equal(firstReply, "fake: @p2 how many files are here?");
  assert.equal(modelCalls, 0);
});
await check("the person's words reach the program unchanged - no mention directive, no runtime notes", () => {
  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt, "@p2 how many files are here?");
});
await check("it works in the project's folder, on its default model, with project access", () => {
  const request = requests[0];
  assert.equal(path.basename(request.cwd), "p1");
  assert.equal(request.model, "");
  assert.equal(request.access, "project");
});
await check("a session that is starting is told whose project it is and what the person wrote down", () => {
  const request = requests[0];
  assert.equal(request.sessionId, null);
  assert.match(request.brief, /Proj One/);
  assert.match(request.brief, /P1-MARKER/);
  assert.doesNotMatch(request.brief, /eggent_/, "the brief must not name tools the program does not have");
});
await check("the steps stream to the card while the program works", () => {
  const updates = events.filter((event) => event.type === "tool_execution_update");
  const withSteps = updates.find((event) => {
    const details = (event.partialResult as { details?: { steps?: unknown[] } } | undefined)?.details;
    return Array.isArray(details?.steps) && details.steps.length > 0;
  });
  assert.ok(withSteps, "no update carried the program's steps");
  const details = (withSteps!.partialResult as { details: { steps: Array<{ tool: string; target?: string }> } }).details;
  assert.deepEqual(details.steps[0], { tool: "Read", target: "README.md" });
});
await check("the answer is stored in the chat, with the engine's card", async () => {
  const chat = await getChat(first);
  const answer = chat?.messages.filter((message) => message.role === "assistant").pop();
  assert.ok(answer);
  assert.match(answer!.content, /fake: @p2 how many files are here\?/);
  assert.ok((answer!.toolCalls ?? []).some((call) => call.toolName === "engine_run"), "the engine tool call is not on the message");
});
await check("its session is kept on this computer, outside the project", async () => {
  const record = await store.readEngineSession(first);
  assert.ok(record && record.sessionId === "sess-1" && record.engine === "fake");
  assert.ok(fs.existsSync(path.join(agentDir, "engine-sessions.json")));
  assert.ok(!fs.existsSync(path.join(root, "data", "projects", "p1", "engine-sessions.json")));
});

console.log("\nThe next message\n");

requests.length = 0;
await runPiAgentText({ chatId: first, projectId: "p1", userMessage: "and now the folders?" });
await check("continues the program's own session instead of starting one", () => {
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionId, "sess-1");
  assert.equal(requests[0].brief, "", "a resumed session is not told its instructions again");
  assert.equal(requests[0].recap, "");
});
await check("instructions the person changed are told to the session in the message", async () => {
  requests.length = 0;
  await projectStore.saveProjectContext("p1", "P1-MARKER-V2: keep notes in journal.md.");
  await runPiAgentText({ chatId: first, projectId: "p1", userMessage: "what changed?" });
  assert.equal(requests[0].sessionId, "sess-1");
  assert.match(requests[0].prompt, /instructions for this project have changed/);
  assert.match(requests[0].prompt, /P1-MARKER-V2/);
});

console.log("\nA chat that began elsewhere\n");

await check("the first turn of a chat with history is told what was said before it", async () => {
  const id = await newChat("Began in the cloud", "p1");
  const chat = await getChat(id);
  assert.ok(chat);
  const stamp = new Date().toISOString();
  chat!.messages.push(
    { id: "m1", role: "user", content: "We are renaming the shop to Lumen.", createdAt: stamp },
    { id: "m2", role: "assistant", content: "Understood: Lumen it is.", createdAt: stamp },
  );
  await saveChat(chat!);
  requests.length = 0;
  await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "what is the shop called now?" });
  assert.equal(requests.length, 1);
  assert.match(requests[0].recap, /renaming the shop to Lumen/);
  assert.match(requests[0].recap, /Lumen it is/);
  assert.doesNotMatch(requests[0].recap, /what is the shop called now/, "the request itself is not history");
});
await check("the recap keeps the most recent words when there are too many", () => {
  const stamp = new Date().toISOString();
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${"word ".repeat(120)}#${index}`,
    createdAt: stamp,
  }));
  const recap = buildEngineRecap(many as never);
  assert.ok(recap.length < 7000, `recap is ${recap.length} chars`);
  assert.match(recap, /#39/);
  assert.doesNotMatch(recap, /#0\b/);
});
await check("a session the program has lost starts over, and is told what was said", async () => {
  const id = await newChat("Lost session", "p1");
  await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "first thing" });
  requests.length = 0;
  const reply = await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "LOST then continue" });
  assert.equal(requests.length, 2, "one try with the old session, one without");
  assert.equal(requests[0].sessionId, "sess-1");
  assert.equal(requests[1].sessionId, null);
  assert.match(requests[1].recap, /first thing/);
  assert.match(reply, /fake: LOST then continue/);
});

console.log("\nWhen it cannot\n");

await check("a program that is not signed in says so in the chat and is not started", async () => {
  status = { state: "signed-out" };
  registry.forgetEngineStatus("fake");
  const id = await newChat("Signed out", "p1");
  requests.length = 0;
  const reply = await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "hello" });
  assert.equal(requests.length, 0);
  assert.match(reply, /Fake Code is not signed in on this computer/);
  status = { state: "ready", version: "1.0.0", account: "Max" };
  registry.forgetEngineStatus("fake");
});
await check("a subscription limit says until when", async () => {
  const id = await newChat("Limit", "p1");
  const reply = await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "LIMIT please" });
  assert.match(reply, /reached the limit of your subscription \(it opens again at \d\d:\d\d\)/);
});
await check("once a program has said its limit is reached, the next messages are told so without starting it again", async () => {
  const id = await newChat("Limited", "p1");
  requests.length = 0;
  const reply = await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "anything at all" });
  assert.equal(requests.length, 0, "the program was started for a message that could only hear the limit again");
  assert.match(reply, /reached the limit of your subscription \(it opens again at \d\d:\d\d\)/);
  limits.forgetEngineLimit("fake");
  const after = await runPiAgentText({ chatId: id, projectId: "p1", userMessage: "and now?" });
  assert.equal(requests.length, 1);
  assert.match(after, /fake: and now\?/);
});
await check("Stop reaches the program and the turn ends", async () => {
  const id = await newChat("Stop", "p1");
  const pending = runPiAgentText({ chatId: id, projectId: "p1", userMessage: "SLOW work" });
  await sleep(600);
  assert.ok(stopActiveRun(id), "the turn was not registered as running");
  const reply = await Promise.race([pending, sleep(8000).then(() => "TIMED OUT")]);
  assert.notEqual(reply, "TIMED OUT");
  assert.ok(requests.at(-1)!.signal.aborted, "the program never heard the stop");
});

console.log("\nA few at a time\n");

await check("no more programs run at once than the cap allows, and the others wait their turn in order", async () => {
  process.env.EGGENT_ENGINE_MAX_PARALLEL = "2";
  limits.resetEngineLimitsForTest();
  const slots = [] as Array<Awaited<ReturnType<typeof limits.acquireEngineSlot>>>;
  slots.push(await limits.acquireEngineSlot(undefined));
  slots.push(await limits.acquireEngineSlot(undefined));
  const order: string[] = [];
  let waited = 0;
  const third = limits.acquireEngineSlot(undefined, () => { waited += 1; }).then((slot) => { order.push("third"); return slot; });
  const fourth = limits.acquireEngineSlot(undefined, () => { waited += 1; }).then((slot) => { order.push("fourth"); return slot; });
  await sleep(50);
  assert.deepEqual(order, [], "a place was given out beyond the cap");
  assert.equal(waited, 2, "the waiting callers were not told they were waiting");
  slots[0]!.release();
  const thirdSlot = await third;
  assert.deepEqual(order, ["third"]);
  slots[1]!.release();
  const fourthSlot = await fourth;
  assert.deepEqual(order, ["third", "fourth"]);
  slots[0]!.release(); // releasing twice must not hand out a second place
  thirdSlot!.release();
  fourthSlot!.release();
  const again = [await limits.acquireEngineSlot(undefined), await limits.acquireEngineSlot(undefined)];
  let extra = false;
  void limits.acquireEngineSlot(undefined).then(() => { extra = true; });
  await sleep(30);
  assert.equal(extra, false, "the count of running programs leaked");
  again.forEach((slot) => slot!.release());
  await sleep(10);
  limits.resetEngineLimitsForTest();
});
await check("a stop given while a run waits for its place ends the wait and takes nothing", async () => {
  process.env.EGGENT_ENGINE_MAX_PARALLEL = "1";
  limits.resetEngineLimitsForTest();
  const first = await limits.acquireEngineSlot(undefined);
  const controller = new AbortController();
  const waiting = limits.acquireEngineSlot(controller.signal);
  await sleep(20);
  controller.abort();
  assert.equal(await waiting, null);
  first!.release();
  const next = await Promise.race([limits.acquireEngineSlot(undefined), sleep(500).then(() => "STUCK" as const)]);
  assert.notEqual(next, "STUCK", "the abandoned wait still held the place");
  if (next && next !== "STUCK") next.release();
  delete process.env.EGGENT_ENGINE_MAX_PARALLEL;
  limits.resetEngineLimitsForTest();
});
await check("three chats started together on one program run two and the third waits, and all three answer", async () => {
  process.env.EGGENT_ENGINE_MAX_PARALLEL = "2";
  limits.resetEngineLimitsForTest();
  let live = 0;
  let peak = 0;
  const run = fake.run;
  fake.run = async (request) => {
    live += 1;
    peak = Math.max(peak, live);
    await sleep(250);
    try {
      return await run(request);
    } finally {
      live -= 1;
    }
  };
  try {
    const ids = await Promise.all([newChat("P-a", "p1"), newChat("P-b", "p1"), newChat("P-c", "p1")]);
    const replies = await Promise.all(ids.map((id, index) => runPiAgentText({ chatId: id, projectId: "p1", userMessage: `parallel ${index}` })));
    assert.deepEqual(replies, ["fake: parallel 0", "fake: parallel 1", "fake: parallel 2"]);
    assert.equal(peak, 2, `${peak} programs ran at once`);
  } finally {
    fake.run = run;
    delete process.env.EGGENT_ENGINE_MAX_PARALLEL;
    limits.resetEngineLimitsForTest();
  }
});

console.log("\nWhat is not on an engine\n");

await check("a project without a choice still uses its model", async () => {
  const id = await newChat("Plain", "p2");
  modelCalls = 0;
  const reply = await runPiAgentText({ chatId: id, projectId: "p2", userMessage: "hello" });
  assert.equal(reply, "from the model");
  assert.ok(modelCalls >= 1);
});
await check("the choice is kept per computer: nothing was written into any project folder", () => {
  assert.ok(fs.existsSync(path.join(agentDir, "engines.json")));
  for (const project of ["p1", "p2"]) {
    const dir = path.join(root, "data", "projects", project);
    assert.ok(!fs.existsSync(path.join(dir, "engines.json")));
    const model = path.join(dir, "model.json");
    if (fs.existsSync(model)) assert.doesNotMatch(fs.readFileSync(model, "utf-8"), /engine|fake/);
  }
});
await check("a choice naming an engine this build does not have is ignored, not an error", async () => {
  await store.writeEngineChoice("p2", { engine: "gone", model: "", access: "project" });
  const id = await newChat("Gone", "p2");
  const reply = await runPiAgentText({ chatId: id, projectId: "p2", userMessage: "hello" });
  assert.equal(reply, "from the model");
  await store.writeEngineChoice("p2", null);
});
await check("the orchestrator can be set too, and is not confused with a project", async () => {
  await store.writeEngineChoice(null, { engine: "fake", model: "fast", access: "full" });
  const id = await newChat("Orchestrator");
  requests.length = 0;
  await runPiAgentText({ chatId: id, userMessage: "hello from the top" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "fast");
  assert.equal(requests[0].access, "full");
  await store.writeEngineChoice(null, null);
});

console.log("\nThe web stream\n");

await check("a turn started from the web chat runs on the engine too", async () => {
  const id = await newChat("Web", "p1");
  requests.length = 0;
  const stream = await createPiChatUIMessageStream({
    chatId: id,
    projectId: "p1",
    userMessage: "from the web",
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "from the web" }] }],
  } as never);
  const reader = stream.getReader();
  let text = "";
  type Stats = { engine?: boolean; context?: unknown; session?: unknown; model?: { name?: string } };
  let stats = null as Stats | null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value as { type?: string; delta?: string; data?: Stats };
    if (chunk.type === "text-delta" && chunk.delta) text += chunk.delta;
    if (chunk.type === "data-piStats" && chunk.data) stats = chunk.data;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt, "from the web");
  assert.match(text, /fake: from the web/);
  // The footer must not show a row of zero tokens for a program that is not ours to count.
  assert.ok(stats, "no runtime stats were streamed");
  assert.equal(stats!.engine, true);
  assert.equal(stats!.context, undefined);
  assert.equal(stats!.session, undefined);
});

provider.close();
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
