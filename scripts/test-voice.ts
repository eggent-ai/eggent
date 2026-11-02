/**
 * Voice calls with the agent: the two tools the voice model has, what it is
 * told about the turn in the chat, and the workspace's routes - the secret
 * comes from the deployment with the workspace's token and only this site's
 * session gets it, beats pass through, and an ended call lands in its chat as
 * a card with what was said.
 *
 * Run with Node 22: npm run test:voice
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildVoiceInstructions,
  cleanTranscript,
  describeTurn,
  formatCallLength,
  questionUpdate,
  sessionUpdate,
  functionCallOf,
  turnDetectionUpdate,
  isAmendment,
  overlapOf,
  gateMic,
  rmsOf,
  GATE_HOLD_MS,
  isAnswerPace,
  PACE_MS,
  endingNote,
  watchCall,
  IDLE_WARN_MS,
  IDLE_GRACE_AFTER_WARNING_MS,
  MUTED_END_MS,
  recentForVoice,
  runVoiceTool,
  voiceContextOf,
  VOICE_TOOLS,
  type TurnMessage,
} from "../src/lib/voice/tools.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

console.log("voice tools:");

function fakeChat(running: boolean) {
  const sent: string[] = [];
  return {
    sent,
    deps: {
      delegate: (task: string, _amends: boolean) => {
        sent.push(task);
        return running ? ("added" as const) : ("started" as const);
      },
      turn: () => describeTurn([], running),
    },
  };
}

await check("the voice model is offered exactly delegate and status", () => {
  assert.deepEqual(VOICE_TOOLS.map((tool) => tool.name), ["delegate", "status"]);
  assert.deepEqual((VOICE_TOOLS[0].parameters as { required: string[] }).required, ["task"]);
});
await check("delegate hands the task, in the person's words, to the chat: a turn of its own when idle", async () => {
  const chat = fakeChat(false);
  const out = await runVoiceTool("delegate", JSON.stringify({ task: "  Draft the contract for Ivanov  " }), chat.deps);
  assert.equal(out.ok, true);
  assert.equal(out.how, "started");
  assert.deepEqual(chat.sent, ["Draft the contract for Ivanov"]);
  assert.match(String(out.note), /do not invent/);
});
await check("delegate while the agent works adds to that turn, and says so", async () => {
  const chat = fakeChat(true);
  const out = await runVoiceTool("delegate", JSON.stringify({ task: "also cc the accountant" }), chat.deps);
  assert.equal(out.how, "added");
  assert.deepEqual(chat.sent, ["also cc the accountant"]);
});
await check("an empty, missing or malformed task reaches nobody and is answered as a failure", async () => {
  const chat = fakeChat(false);
  for (const args of ["{}", JSON.stringify({ task: "   " }), JSON.stringify({ task: 42 }), "not json", "[]"]) {
    const out = await runVoiceTool("delegate", args, chat.deps);
    assert.equal(out.ok, false, args);
  }
  assert.equal((await runVoiceTool("delegate", JSON.stringify({ task: "x".repeat(8001) }), chat.deps)).ok, false);
  assert.deepEqual(chat.sent, []);
});
await check("a delegate that fails is reported, not claimed done", async () => {
  const out = await runVoiceTool("delegate", JSON.stringify({ task: "send it" }), {
    delegate: () => { throw new Error("offline"); },
    turn: () => describeTurn([], false),
  });
  assert.deepEqual(out, { ok: false, error: "offline" });
});
await check("an unknown tool is refused by name", async () => {
  const out = await runVoiceTool("delete_everything", "{}", fakeChat(false).deps);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /delete_everything/);
});

const working: TurnMessage[] = [
  { role: "user", parts: [{ type: "text", text: "find the invoice" }] },
  {
    role: "assistant",
    parts: [
      { type: "text", text: "Looking through the files." },
      { type: "tool-read", state: "output-available" },
      { type: "dynamic-tool", toolName: "bash", state: "input-available" },
    ],
  },
];
await check("status tells what the turn is doing now, what it finished and the latest words", async () => {
  const out = await runVoiceTool("status", "", { delegate: () => "started", turn: () => describeTurn(working, true) });
  assert.equal(out.ok, true);
  assert.equal(out.running, true);
  assert.deepEqual(out.doing, ["bash"]);
  assert.deepEqual(out.done, ["read"]);
  assert.equal(out.latestText, "Looking through the files.");
});
await check("a finished turn has nothing running even when a tool part never closed", () => {
  const status = describeTurn(working, false);
  assert.equal(status.running, false);
  assert.deepEqual(status.doing, []);
  assert.equal(describeTurn([], false).latestText, "");
});
await check("a long answer is told by its end, where the latest words are", () => {
  const status = describeTurn([{ role: "assistant", parts: [{ type: "text", text: `${"a".repeat(800)} THE END` }] }], false);
  assert.ok(status.latestText.length <= 500);
  assert.ok(status.latestText.endsWith("THE END"));
});

await check("a question the agent waits on is part of the status, told aloud, and a spoken answer reaches it", async () => {
  const question = { id: "q1", title: "Which Google services?", message: "Pick one or several", options: ["Gmail", "Calendar", "", "Drive"] };
  const status = describeTurn(working, true, question);
  assert.deepEqual(status.question, { text: "Which Google services? - Pick one or several", options: ["Gmail", "Calendar", "Drive"] });
  assert.match(questionUpdate(question), /^\[Agent update\] The agent asks the person on screen: Which Google services\?.*Choices: Gmail; Calendar; Drive\..*`delegate`/);
  const sent: string[] = [];
  const out = await runVoiceTool("delegate", JSON.stringify({ task: "Gmail and Calendar" }), { delegate: (task) => { sent.push(task); return "answered"; }, turn: () => status });
  assert.equal(out.how, "answered");
  assert.match(String(out.note), /answered the question/);
  assert.deepEqual(sent, ["Gmail and Calendar"]);
  assert.equal(describeTurn(working, true, null).question, undefined);
});
await check("the instructions carry the newest messages that fit, oldest first, and say to delegate the work", () => {
  const messages = voiceContextOf([
    { role: "user", parts: [{ type: "text", text: "first" }] },
    { role: "assistant", parts: [{ type: "tool-read", state: "output-available" }] },
    { role: "assistant", parts: [{ type: "text", text: "second" }] },
    { role: "system", parts: [{ type: "text", text: "hidden" }] },
  ]);
  assert.deepEqual(messages, [{ role: "user", text: "first" }, { role: "assistant", text: "second" }]);
  const text = buildVoiceInstructions({ locale: "ru", projectName: "Shop", recent: recentForVoice(messages) });
  assert.match(text, /Person: first\nAgent: second/);
  assert.match(text, /call `delegate`/);
  assert.match(text, /connect a service/);
  assert.match(text, /at once/);
  assert.match(text, /keep the conversation going/);
  assert.match(text, /language the person speaks/);
  assert.match(text, /"ru"/);
  assert.match(text, /project "Shop"/);
  const many = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, text: `${i} ${"x".repeat(300)}` }));
  const kept = recentForVoice(many);
  assert.ok(kept.length < 40 && kept.length > 5);
  assert.ok(kept.at(-1)!.text.startsWith("39 "));
});
await check("the OpenAI Realtime GA shape keeps voice and turn detection inside audio; the flat shape keeps them at the top", () => {
  const update = sessionUpdate({ protocol: "openai-ga", voice: "voice-a", instructions: "hi", silenceMs: 600 }) as { type: string; session: Record<string, any> };
  assert.equal(update.type, "session.update");
  assert.equal(update.session.type, "realtime");
  assert.deepEqual(update.session.output_modalities, ["audio"]);
  assert.equal(update.session.audio.output.voice, "voice-a");
  assert.deepEqual(update.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(update.session.audio.input.turn_detection.silence_duration_ms, 600);
  assert.equal(update.session.voice, undefined, "voice at the top is the flat shape");
  assert.deepEqual(update.session.tools.map((tool: { name: string }) => tool.name), ["delegate", "status"]);
  const flat = sessionUpdate({ protocol: "flat", voice: "voice-b", instructions: "hi", silenceMs: 600, transcriptionModel: "transcriber-1" }) as { session: Record<string, any> };
  assert.equal(flat.session.voice, "voice-b");
  assert.equal(flat.session.turn_detection.type, "server_vad");
  assert.equal(flat.session.audio.input.transcription.model, "transcriber-1");
  const untold = sessionUpdate({ protocol: "flat", voice: "voice-b", instructions: "hi", silenceMs: 600 }) as { session: Record<string, any> };
  assert.equal(untold.session.audio.input.transcription, undefined, "no transcription model is named unless the deployment names one");
});
await check("the answer speed a person picks is 500, 800 or 1200 ms, and changes only the pause mid-call", () => {
  assert.deepEqual(PACE_MS, { fast: 1500, normal: 2500, calm: 3500 });
  assert.ok(isAnswerPace("calm"));
  assert.ok(!isAnswerPace("slow"));
  assert.ok(!isAnswerPace(null));
  assert.deepEqual(turnDetectionUpdate("openai-ga", 1400, 0.6), {
    type: "session.update",
    session: { type: "realtime", audio: { input: { turn_detection: { type: "server_vad", threshold: 0.6, silence_duration_ms: 1400 } } } },
  });
  const flat = turnDetectionUpdate("flat", 500) as { session: Record<string, unknown> };
  assert.deepEqual(flat.session, { turn_detection: { type: "server_vad", silence_duration_ms: 500 } });
});
await check("while our answer plays, its echo does not go up as the person's voice; a person talking over it does, and is not cut into pieces", () => {
  const now = 1_000_000;
  // nothing playing: everything goes up, however quiet
  assert.equal(gateMic({ now, playing: false, micRms: 0.001, outRms: 0, openUntil: 0 }).pass, true);
  // our answer at 0.2 comes back through the microphone at a third of it: held back
  assert.equal(gateMic({ now, playing: true, micRms: 0.07, outRms: 0.2, openUntil: 0 }).pass, false);
  // a person speaking over it, louder than the echo would be: through, and the gate stays open
  const through = gateMic({ now, playing: true, micRms: 0.25, outRms: 0.2, openUntil: 0 });
  assert.equal(through.pass, true);
  assert.equal(through.openUntil, now + GATE_HOLD_MS);
  // a quieter syllable of the same words a moment later still goes up
  assert.equal(gateMic({ now: now + 200, playing: true, micRms: 0.05, outRms: 0.2, openUntil: through.openUntil }).pass, true);
  // and once the hold is over, the echo alone is held back again
  assert.equal(gateMic({ now: now + GATE_HOLD_MS + 1, playing: true, micRms: 0.05, outRms: 0.2, openUntil: through.openUntil }).pass, false);
  // a quiet answer does not lower the bar under the room's own noise
  assert.equal(gateMic({ now, playing: true, micRms: 0.015, outRms: 0.005, openUntil: 0 }).pass, false);
  assert.ok(Math.abs(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  assert.equal(rmsOf(new Float32Array(0)), 0);
});
await check("one request said in two breaths is one task: the fuller version nine seconds later is a correction, not a second task", () => {
  const t0 = 1_000_000;
  // the live case: the name came after a pause, as a fuller request
  const first = { task: "Create a new project. Ask for the name, start by creating it", at: t0, endedAt: null };
  const fuller = "Create a new project named Voice assistant testing, start by creating it";
  assert.ok(overlapOf(first.task, fuller) >= 0.5, `overlap ${overlapOf(first.task, fuller)}`);
  assert.equal(isAmendment({ task: fuller, amends: false, last: first, now: t0 + 9_000 }), true);
  // the voice model saying so is enough while the task runs, whatever the words
  assert.equal(isAmendment({ task: "no, call it Alpha", amends: true, last: first, now: t0 + 40_000 }), true);
  // ... and for half a minute after it ended
  assert.equal(isAmendment({ task: "call it Alpha", amends: true, last: { ...first, endedAt: t0 + 20_000 }, now: t0 + 45_000 }), true);
  assert.equal(isAmendment({ task: "call it Alpha", amends: true, last: { ...first, endedAt: t0 + 20_000 }, now: t0 + 60_000 }), false);
  // a different task right after is a task of its own
  assert.equal(isAmendment({ task: "Find flights to Kazan for Friday", amends: false, last: first, now: t0 + 5_000 }), false);
  // the same words long after are a new request
  assert.equal(isAmendment({ task: fuller, amends: false, last: first, now: t0 + 60_000 }), false);
  // nothing before: never a correction
  assert.equal(isAmendment({ task: fuller, amends: true, last: null, now: t0 }), false);
});
await check("a correction is handed to the chat as one, and the voice model is told it was", async () => {
  const sent: Array<[string, boolean]> = [];
  const out = await runVoiceTool("delegate", JSON.stringify({ task: "call it Alpha", amends: true }), {
    delegate: (task, amends) => { sent.push([task, amends]); return "amended"; },
    turn: () => describeTurn([], true),
  });
  assert.deepEqual(sent, [["call it Alpha", true]]);
  assert.equal(out.how, "amended");
  assert.match(String(out.note), /correction/);
  const tool = VOICE_TOOLS[0].parameters as { properties: Record<string, { type: string }> };
  assert.equal(tool.properties.amends.type, "boolean");
});
await check("a function call is read from either provider's event, and both name the same call", () => {
  const fromArgumentsDone = functionCallOf({ type: "response.function_call_arguments.done", name: "delegate", call_id: "c1", arguments: "{\"task\":\"x\"}" });
  const fromOutputItem = functionCallOf({ type: "response.output_item.done", item: { type: "function_call", name: "delegate", call_id: "c1", arguments: "{\"task\":\"x\"}" } });
  assert.deepEqual(fromArgumentsDone, { name: "delegate", callId: "c1", arguments: "{\"task\":\"x\"}" });
  assert.deepEqual(fromOutputItem, fromArgumentsDone);
  assert.equal(functionCallOf({ type: "response.output_item.done", item: { type: "message" } }), null);
  assert.equal(functionCallOf({ type: "response.function_call_arguments.done", name: "delegate" }), null);
});
await check("a quiet line is warned at 45 s and ended 15 s after the warning unless the person speaks", () => {
  const t0 = 1_000_000;
  const base = { lastPersonAt: t0, lastAgentAt: t0, mutedSince: null, warnedAt: null };
  assert.equal(watchCall({ ...base, now: t0 + IDLE_WARN_MS - 1 }), "ok");
  assert.equal(watchCall({ ...base, now: t0 + IDLE_WARN_MS }), "warn");
  const warned = { ...base, warnedAt: t0 + IDLE_WARN_MS };
  // the voice speaking the warning does not buy more time
  assert.equal(watchCall({ ...warned, lastAgentAt: t0 + IDLE_WARN_MS + 4000, now: t0 + IDLE_WARN_MS + IDLE_GRACE_AFTER_WARNING_MS - 1 }), "ok");
  assert.equal(watchCall({ ...warned, lastAgentAt: t0 + IDLE_WARN_MS + 4000, now: t0 + IDLE_WARN_MS + IDLE_GRACE_AFTER_WARNING_MS }), "end-idle");
  // the person answering the warning keeps the call
  assert.equal(watchCall({ ...warned, lastPersonAt: t0 + IDLE_WARN_MS + 3000, now: t0 + IDLE_WARN_MS + 60_000 }), "ok");
  // the agent talking counts as a line in use
  assert.equal(watchCall({ ...base, lastAgentAt: t0 + 30_000, now: t0 + IDLE_WARN_MS + 1000 }), "ok");
});
await check("a muted microphone is not idle, but two minutes of it end the call", () => {
  const t0 = 1_000_000;
  const muted = { lastPersonAt: t0, lastAgentAt: t0, mutedSince: t0, warnedAt: null };
  assert.equal(watchCall({ ...muted, now: t0 + 90_000 }), "ok");
  assert.equal(watchCall({ ...muted, now: t0 + MUTED_END_MS }), "end-muted");
});
await check("the voice is told why the call ends, in words for the person, not the person's own", () => {
  assert.match(endingNote("balance"), /^\[Call note - not from the person\].*balance.*goodbye/);
  assert.match(endingNote("time"), /time limit/);
});
await check("the placeholder for a call's summary belongs to its chat, can fail, and goes away", async () => {
  const { startSummary, failSummary, clearSummary, pendingSummary } = await import("../src/lib/voice/summary-state.ts");
  startSummary("chat-a");
  assert.equal(pendingSummary()?.chatId, "chat-a");
  assert.equal(pendingSummary()?.state, "pending");
  // another chat's failure or clearing leaves it alone
  failSummary("chat-b");
  clearSummary("chat-b");
  assert.equal(pendingSummary()?.state, "pending");
  failSummary("chat-a");
  assert.equal(pendingSummary()?.state, "failed");
  clearSummary("chat-a");
  assert.equal(pendingSummary(), null);
});
await check("a call's length reads like a phone's", () => {
  assert.equal(formatCallLength(124), "02:04");
  assert.equal(formatCallLength(0), "00:00");
  assert.equal(formatCallLength(3725), "1:02:05");
});
await check("a transcript from the page is kept to its shape", () => {
  assert.deepEqual(cleanTranscript([
    { role: "user", text: " hi " },
    { role: "system", text: "x" },
    { role: "agent", text: "" },
    { role: "agent", text: 5 },
    null,
    { role: "agent", text: "hello" },
  ]), [{ role: "user", text: "hi" }, { role: "agent", text: "hello" }]);
  assert.deepEqual(cleanTranscript("nope"), []);
  assert.equal(cleanTranscript(Array.from({ length: 900 }, () => ({ role: "user", text: "a" }))).length, 400);
});

// --- the routes, against a stand-in deployment ----------------------------

console.log("voice routes:");
const cloud = { calls: [] as Array<{ method: string; url: string; auth: string | undefined }> };
const cloudServer = http.createServer((req, res) => {
  cloud.calls.push({ method: req.method || "", url: req.url || "", auth: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization !== "Bearer eggw_workspace_token") { res.statusCode = 401; return res.end("{}"); }
  if (req.url === "/v1/tools/voice/call" && req.method === "GET") return res.end(JSON.stringify({ available: true, pricePerMinute: "€0.10", balanceLeft: "€0.43" }));
  if (req.url === "/v1/tools/voice/call" && req.method === "POST") {
    if (cloudRefuses) { res.statusCode = 402; return res.end(JSON.stringify({ error: "The balance is too low for a call.", code: "balance", pricePerMinute: "€0.10", balanceLeft: "€0.01" })); }
    res.statusCode = 201;
    return res.end(JSON.stringify({ call: { id: "a".repeat(32) }, mode: "direct", protocol: "flat", subprotocolPrefix: "client-secret.", silenceMs: 600, secret: "eph_secret", realtimeUrl: "wss://voice.example.test/v1/realtime?model=m", model: "m", voice: "voice-b", maxSeconds: 600, beatSeconds: 10, pricePerMinute: "€0.10", balanceLeft: "€0.43" }));
  }
  if (req.url === `/v1/tools/voice/call/${"a".repeat(32)}/beat`) return res.end(JSON.stringify({ continue: true, leftSeconds: 590, balanceLeft: "€0.41" }));
  if (req.url === `/v1/tools/voice/call/${"a".repeat(32)}` && req.method === "DELETE") return res.end(JSON.stringify({ ok: true, ended: true, seconds: 64 }));
  res.statusCode = 404;
  res.end("{}");
});
let cloudRefuses = false;
await new Promise<void>((resolve) => cloudServer.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-voice-"));
process.chdir(root);
process.env.EGGENT_AUTH_SECRET = "voice-test-secret-0123456789abcdef";
process.env.EGGENT_VOICE_API_URL = `http://127.0.0.1:${(cloudServer.address() as { port: number }).port}/v1/tools/voice/`;
process.env.EGGENT_USAGE_API_TOKEN = "eggw_workspace_token";

const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const { NextRequest } = await import("next/server");
const { getChat, createChat } = await import("../src/lib/storage/chat-store.ts");
const callRoute = await import("../src/app/api/voice/call/route.ts");
const beatRoute = await import("../src/app/api/voice/call/[callId]/route.ts");
const endRoute = await import("../src/app/api/voice/call/[callId]/end/route.ts");

const cookie = `${AUTH_COOKIE_NAME}=${await createSessionToken("owner@example.test", false)}`;
function request(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://workspace.example.test${url}`, {
    method,
    headers: { cookie, origin: "http://workspace.example.test", host: "workspace.example.test", "content-type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}
const CALL = "a".repeat(32);
const CHAT = "11111111-2222-4333-8444-555555555555";

await check("starting a call needs this site's session and JSON; nobody else gets the secret", async () => {
  const before = cloud.calls.length;
  assert.equal((await callRoute.POST(request("/api/voice/call", "POST", {}, { cookie: "" }))).status, 401);
  assert.equal((await callRoute.POST(request("/api/voice/call", "POST", {}, { origin: "http://sibling.example.test" }))).status, 403);
  assert.equal((await callRoute.POST(request("/api/voice/call", "POST", {}, { "content-type": "text/plain" }))).status, 415);
  assert.equal(cloud.calls.length, before, "a refused request reached the deployment");
});
await check("a call's secret comes from the deployment, asked with the workspace's own token, which the page never sees", async () => {
  const response = await callRoute.POST(request("/api/voice/call", "POST", {}));
  assert.equal(response.status, 201);
  const text = await response.text();
  const json = JSON.parse(text);
  assert.equal(json.callId, CALL);
  assert.equal(json.secret, "eph_secret");
  assert.equal(json.mode, "direct");
  assert.equal(json.protocol, "flat");
  assert.equal(json.subprotocolPrefix, "client-secret.");
  assert.equal(json.silenceMs, 600);
  assert.equal(json.pricePerMinute, "€0.10");
  assert.equal(json.balanceLeft, "€0.43");
  assert.equal(json.realtimeUrl, "wss://voice.example.test/v1/realtime?model=m");
  assert.ok(!text.includes("eggw_workspace_token"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(cloud.calls.at(-1)!.auth, "Bearer eggw_workspace_token");
});
await check("a refusal for money is passed on as said, with its code, the price and what is left", async () => {
  cloudRefuses = true;
  const response = await callRoute.POST(request("/api/voice/call", "POST", {}));
  cloudRefuses = false;
  assert.equal(response.status, 402);
  const json = await response.json();
  assert.equal(json.code, "balance");
  assert.match(json.error, /too low/);
  assert.equal(json.balanceLeft, "€0.01");
});
await check("the status says whether calls are offered", async () => {
  const json = await (await callRoute.GET(request("/api/voice/call", "GET", null))).json();
  assert.deepEqual(json, { available: true, pricePerMinute: "€0.10", balanceLeft: "€0.43" });
});
await check("a beat goes through for a call id, and nothing that is not one", async () => {
  const ok = await beatRoute.POST(request(`/api/voice/call/${CALL}`, "POST", {}), { params: Promise.resolve({ callId: CALL }) });
  assert.deepEqual(await ok.json(), { continue: true, leftSeconds: 590, reason: null, balanceLeft: "€0.41" });
  const bad = await beatRoute.POST(request("/api/voice/call/..%2F..", "POST", {}), { params: Promise.resolve({ callId: "../.." }) });
  assert.equal(bad.status, 400);
});
await check("an ended call lands in its chat as one card with what was said and the summary, timed by the deployment", async () => {
  await createChat(CHAT, "Talk", undefined);
  const response = await endRoute.POST(request(`/api/voice/call/${CALL}/end`, "POST", {
    chatId: CHAT,
    seconds: 9999,
    summary: "Discussed the contract. Handed the draft to the agent.",
    transcript: [{ role: "user", text: "Γεια, φτιάξε τη σύμβαση" }, { role: "agent", text: "Το έδωσα στον πράκτορα." }, { role: "hacker", text: "x" }],
    delegated: ["φτιάξε τη σύμβαση", 5],
  }), { params: Promise.resolve({ callId: CALL }) });
  const json = await response.json();
  assert.equal(json.recorded, true);
  assert.equal(cloud.calls.at(-1)!.method, "DELETE");
  const chat = await getChat(CHAT);
  const card = chat!.messages.at(-1)!;
  assert.equal(card.role, "assistant");
  assert.equal(card.content, "Discussed the contract. Handed the draft to the agent.");
  assert.equal(card.voiceCall!.seconds, 64, "the page's own count was believed over the deployment's");
  assert.deepEqual(card.voiceCall!.transcript, [{ role: "user", text: "Γεια, φτιάξε τη σύμβαση" }, { role: "agent", text: "Το έδωσα στον πράκτορα." }]);
  assert.deepEqual(card.voiceCall!.delegated, ["φτιάξε τη σύμβαση"]);
});
await check("the card is drawn from the stored chat after a reload", async () => {
  const { chatMessagesToUIMessages } = await import("../src/lib/chat/ui-messages.ts");
  const chat = await getChat(CHAT);
  const ui = chatMessagesToUIMessages(chat!.messages);
  const last = ui.at(-1)!;
  assert.equal((last.parts[0] as { type: string }).type, "data-eggentVoiceCall");
  assert.ok(last.parts.some((part) => part.type === "text"));
});
await check("a call in a chat nobody had written in yet makes the chat; a call where nothing was said leaves nothing", async () => {
  const fresh = "99999999-2222-4333-8444-555555555555";
  const empty = await endRoute.POST(request(`/api/voice/call/${CALL}/end`, "POST", { chatId: fresh, transcript: [], summary: "" }), { params: Promise.resolve({ callId: CALL }) });
  assert.equal((await empty.json()).recorded, false);
  assert.equal(await getChat(fresh), null);
  await endRoute.POST(request(`/api/voice/call/${CALL}/end`, "POST", { chatId: fresh, transcript: [{ role: "user", text: "hello" }], summary: "", projectId: "../../etc" }), { params: Promise.resolve({ callId: CALL }) });
  const chat = await getChat(fresh);
  assert.ok(chat);
  assert.equal(chat!.projectId, undefined, "a path was accepted as a project id");
  assert.equal(chat!.messages.length, 1);
});
await check("ending needs the session too", async () => {
  const response = await endRoute.POST(request(`/api/voice/call/${CALL}/end`, "POST", { chatId: CHAT }, { cookie: "" }), { params: Promise.resolve({ callId: CALL }) });
  assert.equal(response.status, 401);
});

cloudServer.close();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
