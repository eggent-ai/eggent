/**
 * A session that is kept for its schedules serves one turn after another.
 *
 * Its tools were built for the turn that made the schedule: they held that
 * turn's run id, its stop signal and its way of putting a question on the
 * screen. So a question asked in the chat's next turn went to a stream nobody
 * was reading and could not be answered, and a turn that had been stopped left
 * its aborted signal behind for every command a scheduled run ran afterwards.
 * Driven through the real session's own tools. No model, no network. Run with
 * Node 22:
 *   npm run test:session-rebind
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-session-rebind-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: { stub: { name: "Stub", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "m", name: "M", input: ["text"], contextWindow: 16384, maxTokens: 2048 }] } },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ stub: { type: "api_key", key: "k" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "m" }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";

const { createEggentPiSession, rebindSessionTurn, releaseSessionTurn } = await import("../src/lib/pi/session.ts");
const { listPendingInteractions, cancelPendingInteractionsForRun } = await import("../src/lib/pi/pending-interactions.ts");
import type { PiPendingInteraction } from "../src/lib/pi/interaction-types.ts";

interface Tool {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content?: Array<{ text?: string }> }>;
}

const first: PiPendingInteraction[] = [];
const second: PiPendingInteraction[] = [];
const stopFirst = new AbortController();
const session = await createEggentPiSession({
  chatId: "11111111-1111-4111-8111-111111111111",
  runId: "run-1",
  abortSignal: stopFirst.signal,
  onPiInteraction: (interaction: PiPendingInteraction) => void first.push(interaction),
} as never);
const tools = (session as unknown as { agent: { state: { tools: Tool[] } } }).agent.state.tools;
const tool = (name: string): Tool => {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `no ${name} tool`);
  return found;
};
const text = (result: { content?: Array<{ text?: string }> }) => (result.content ?? []).map((part) => part.text ?? "").join("");

console.log("The turn the session was built for\n");

await check("a question goes to the turn the session was built for, under its run id", async () => {
  const asked = tool("eggent_ask_user").execute("q1", { question: "Which colour?", options: ["red", "blue"] });
  await sleep(100);
  assert.equal(first.length, 1);
  assert.equal(first[0].runId, "run-1");
  cancelPendingInteractionsForRun("run-1");
  await asked;
});

console.log("\nThe next turn of the same chat\n");

const nextStop = new AbortController();
rebindSessionTurn(session, { runId: "run-2", abortSignal: nextStop.signal, onPiInteraction: (interaction: PiPendingInteraction) => void second.push(interaction) });

await check("its question goes to its own stream, under its own run id, where its watchdog looks", async () => {
  const before = first.length;
  const asked = tool("eggent_ask_user").execute("q2", { question: "Which size?", options: ["small", "large"] });
  await sleep(100);
  assert.equal(first.length, before, "the question went to the turn before");
  assert.equal(second.length, 1);
  assert.equal(second[0].runId, "run-2");
  assert.equal(listPendingInteractions("run-2").filter((interaction) => interaction.status === "pending").length, 1);
  assert.equal(listPendingInteractions("run-1").filter((interaction) => interaction.status === "pending").length, 0);
  nextStop.abort();
  await asked;
});
await check("and its stop is the one that counts", async () => {
  const fresh = new AbortController();
  rebindSessionTurn(session, { runId: "run-3", abortSignal: fresh.signal, onPiInteraction: (interaction: PiPendingInteraction) => void second.push(interaction) });
  const before = listPendingInteractions("run-3").length;
  const asked = tool("eggent_ask_user").execute("q3", { question: "Still there?", options: ["yes", "no"] });
  await sleep(100);
  assert.equal(listPendingInteractions("run-3").length, before + 1);
  fresh.abort();
  const result = await Promise.race([asked.then(() => "settled"), sleep(2000).then(() => "STILL-WAITING")]);
  assert.equal(result, "settled", "the question outlived the stop of the turn that asked it");
});

console.log("\nCommands, after a stopped turn\n");

const run = async (command: string) => {
  try {
    return text(await tool("bash").execute("b", { command }));
  } catch (error) {
    return `THROWN: ${error instanceof Error ? error.message : String(error)}`;
  }
};

await check("a command is refused for as long as the signal it holds is one that was stopped", async () => {
  const stopped = new AbortController();
  stopped.abort();
  rebindSessionTurn(session, { runId: "run-4", abortSignal: stopped.signal });
  assert.match(await run("echo rebound"), /abort/i);
});
await check("...and runs again once the session serves a turn that was not", async () => {
  rebindSessionTurn(session, { runId: "run-5", abortSignal: new AbortController().signal });
  assert.match(await run("echo rebound"), /rebound/);
});

console.log("\nWhen the turn ends\n");

await check("a session kept for its schedules serves no one, and nothing it holds is left from the turn", async () => {
  const stoppedLast = new AbortController();
  rebindSessionTurn(session, { runId: "run-6", abortSignal: stoppedLast.signal, onPiInteraction: (interaction: PiPendingInteraction) => void second.push(interaction) });
  stoppedLast.abort();
  rebindSessionTurn(session, {});
  assert.match(await run("echo scheduled"), /scheduled/, "a scheduled run's command inherited the stopped turn's signal");
  const before = second.length;
  const asked = text(await tool("eggent_ask_user").execute("q4", { question: "Anyone?", options: ["a", "b"] }));
  assert.match(asked, /No interactive UI/i);
  assert.equal(second.length, before, "a card was raised for a turn that is over");
});

console.log("\nA session restored at boot for its schedules\n");

await check("lent to a web turn, its question becomes a card although the session was bound with no UI", async () => {
  // A session restored at boot is bound with no UI context, so the SDK hands its tools hasUI: false
  // for good. The web turn it is lent to can still answer: the card must go up, not a refusal.
  const restored = await createEggentPiSession({ chatId: "22222222-2222-4222-8222-222222222222" } as never);
  const restoredTools = (restored as unknown as { agent: { state: { tools: Tool[] } } }).agent.state.tools;
  const ask = restoredTools.find((candidate) => candidate.name === "eggent_ask_user");
  assert.ok(ask);
  const raised: PiPendingInteraction[] = [];
  const stop = new AbortController();
  rebindSessionTurn(restored, { runId: "run-boot", abortSignal: stop.signal, onPiInteraction: (interaction: PiPendingInteraction) => void raised.push(interaction) });
  const asked = ask.execute("qb", { question: "Which day?", options: ["Mon", "Tue"] }, undefined, undefined, { hasUI: false });
  await sleep(100);
  assert.equal(raised.length, 1, "the question was refused as if nobody could answer");
  stop.abort();
  await asked;
  restored.dispose();
});

console.log("\nWhere the turn came from\n");

const fromTelegram = async (): Promise<boolean> => {
  const status = JSON.parse(text(await tool("eggent_manage_telegram").execute("t", { action: "status" }))) as { thisRunFromTelegram?: boolean };
  return Boolean(status.thisRunFromTelegram);
};

await check("a tool delivers by the chat of the turn it serves now, and a finished turn leaves it as it was for the schedules", async () => {
  assert.equal(await fromTelegram(), false, "the session was built for a turn from the web");
  rebindSessionTurn(session, { runId: "run-7", toolRuntimeData: { telegram: { chatId: "4242" } } });
  assert.equal(await fromTelegram(), true, "a tool still thought the turn came from where the session was built for");
  // The turn ends: no run, no stop, no card - but a scheduled run delivers to whoever last used the chat.
  releaseSessionTurn(session);
  assert.equal(await fromTelegram(), true);
  rebindSessionTurn(session, { runId: "run-8" });
  assert.equal(await fromTelegram(), false, "a web turn kept the Telegram chat of the one before");
});

session.dispose();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
