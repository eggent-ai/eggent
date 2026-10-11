/**
 * Reaching a turn that will not end, or has not begun.
 *
 * A turn used to be reachable only once its session was built, so a turn stuck
 * while it was being built - an extension waiting for something nobody could
 * see - could not be stopped by any means. And a stop that a stuck turn ignores
 * left the chat stuck with it. No model, no network. Run with Node 22:
 *   npm run test:turn-control
 */
import assert from "node:assert/strict";
import { clearActiveRun, getActiveRun, registerActiveRun } from "../src/lib/pi/active-runs.ts";
import { getLiveRun, startLiveRun } from "../src/lib/pi/live-run.ts";
import { createPendingInteraction, listPendingInteractions } from "../src/lib/pi/pending-interactions.ts";
import { createStartingRun, raceAbort, resetChatTurn, TurnAbortedError, undoFailedSetup, type TurnSetupScope } from "../src/lib/pi/turn-control.ts";

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

console.log("A turn that has not begun\n");

await check("is registered at once, so it can be reached while its session is built", () => {
  let stopped = 0;
  const starting = createStartingRun(() => {
    stopped += 1;
  });
  registerActiveRun("chat-start", { session: starting.run, runId: "run-1", surface: "external" });
  const active = getActiveRun("chat-start");
  assert.ok(active, "a starting turn must not be dropped as one that has stopped streaming");
  void active.session.abort();
  assert.equal(stopped, 1);
  clearActiveRun("chat-start", "run-1");
});

await check("what is said to it before it can hear is kept, and handed over once", async () => {
  const starting = createStartingRun(() => undefined);
  await starting.run.steer("also the chart");
  await starting.run.steer("and the totals");
  assert.deepEqual(starting.takeQueuedSteers(), ["also the chart", "and the totals"]);
  assert.deepEqual(starting.takeQueuedSteers(), []);
});

await check("a steer waits until the agent runs, and then goes straight to the session", async () => {
  const starting = createStartingRun(() => undefined);
  const heard: string[] = [];
  starting.attach({ steer: async (text: string) => void heard.push(text), isStreaming: false });
  // The session exists but is still getting ready to ask the model: nobody can hear yet.
  await starting.run.steer("early");
  assert.deepEqual(heard, []);
  assert.deepEqual(starting.takeQueuedSteers(), ["early"]);
  starting.markStarted();
  await starting.run.steer("now");
  assert.deepEqual(heard, ["now"]);
  assert.deepEqual(starting.takeQueuedSteers(), []);
});

await check("the turn is going from before its session exists until the agent has finished", () => {
  const starting = createStartingRun(() => undefined);
  let streaming = false;
  const session = { steer: async () => undefined, get isStreaming() { return streaming; } };
  assert.equal(starting.run.isStreaming, true, "while the session is built");
  starting.attach(session);
  assert.equal(starting.run.isStreaming, true, "while the session gets ready to ask the model (compaction, hooks)");
  starting.markStarted();
  streaming = true;
  assert.equal(starting.run.isStreaming, true, "while the agent runs");
  streaming = false;
  assert.equal(starting.run.isStreaming, false, "once the agent has finished it is not held up as a run to join");
});

await check("so the registry keeps a turn that is getting ready, and lets go of one that has finished", () => {
  let streaming = false;
  const starting = createStartingRun(() => undefined);
  starting.attach({ steer: async () => undefined, get isStreaming() { return streaming; } });
  registerActiveRun("chat-ready", { session: starting.run, runId: "run-ready", surface: "external" });
  assert.ok(getActiveRun("chat-ready"), "a turn getting ready was dropped from the registry");
  starting.markStarted();
  streaming = true;
  assert.ok(getActiveRun("chat-ready"));
  streaming = false;
  assert.equal(getActiveRun("chat-ready"), undefined);
});

await check("what a turn set up before it failed is undone, once", async () => {
  const calls: string[] = [];
  const scope: TurnSetupScope = { abandon: (error) => void calls.push(String(error)) };
  await undoFailedSetup(scope, "disk full");
  await undoFailedSetup(scope, "again");
  assert.deepEqual(calls, ["disk full"]);
  // A turn whose own cleanup took over is not undone by its caller.
  const handedOver: TurnSetupScope = { abandon: () => void calls.push("never") };
  handedOver.abandon = undefined;
  await undoFailedSetup(handedOver, "late");
  assert.deepEqual(calls, ["disk full"]);
  // And an undo that itself fails does not hide the failure that came first.
  await undoFailedSetup({ abandon: () => { throw new Error("undo failed"); } }, "first");
});

console.log("\nWaiting for a session, unless told to stop\n");

await check("what is built in time is returned", async () => {
  const controller = new AbortController();
  assert.equal(await raceAbort(Promise.resolve(42), controller.signal), 42);
});

await check("a stop wins over a session that never arrives", async () => {
  const controller = new AbortController();
  const never = new Promise<number>(() => undefined);
  const waiting = raceAbort(never, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error instanceof TurnAbortedError);
});

await check("a session that arrives after the stop is handed back to be thrown away", async () => {
  const controller = new AbortController();
  let release: (value: string) => void = () => undefined;
  const slow = new Promise<string>((resolve) => {
    release = resolve;
  });
  const late: string[] = [];
  const waiting = raceAbort(slow, controller.signal, (value) => late.push(value));
  controller.abort();
  await assert.rejects(waiting, TurnAbortedError);
  release("the session");
  await sleep(10);
  assert.deepEqual(late, ["the session"]);
});

await check("a stop that came first is not waited for at all", async () => {
  const controller = new AbortController();
  controller.abort();
  const late: number[] = [];
  await assert.rejects(raceAbort(Promise.resolve(7), controller.signal, (value) => late.push(value)), TurnAbortedError);
  await sleep(10);
  assert.deepEqual(late, [7]);
});

await check("an error from the work is the error", async () => {
  const controller = new AbortController();
  await assert.rejects(raceAbort(Promise.reject(new Error("no model")), controller.signal), /no model/);
});

console.log("\nUnsticking a chat\n");

/** A turn the way a runner registers one, ending when its requestStop is called - unless it is stuck. */
function startTurn(chatId: string, runId: string, options: { stuck?: boolean } = {}) {
  const live = startLiveRun({ chatId, runId, surface: "external" });
  const state = { stopRequested: 0, finished: false };
  registerActiveRun(chatId, {
    session: { isStreaming: true, abort: async () => undefined, steer: async () => undefined },
    runId,
    surface: "external",
    requestStop: () => {
      state.stopRequested += 1;
      if (options.stuck) return;
      state.finished = true;
      live.finish();
      clearActiveRun(chatId, runId);
    },
  });
  return state;
}

await check("nothing running is reported as nothing running", async () => {
  assert.deepEqual(await resetChatTurn("chat-idle"), { found: false, hadQuestion: false, abandoned: false });
});

await check("a turn that winds down when asked is stopped, and the chat is free", async () => {
  const state = startTurn("chat-a", "run-a");
  const outcome = await resetChatTurn("chat-a", { graceMs: 1000 });
  assert.deepEqual(outcome, { found: true, hadQuestion: false, abandoned: false });
  assert.equal(state.stopRequested, 1);
  assert.equal(getActiveRun("chat-a"), undefined);
  assert.equal(getLiveRun("chat-a"), null);
});

await check("a question nobody can answer is dropped, and the turn is told no one answered", async () => {
  const state = startTurn("chat-q", "run-q");
  let answer: unknown = "unset";
  void createPendingInteraction({ runId: "run-q", kind: "confirm", title: "Allow this server?" }).then((value) => {
    answer = value;
  });
  assert.equal(listPendingInteractions("run-q").length, 1);
  const outcome = await resetChatTurn("chat-q", { graceMs: 1000 });
  assert.equal(outcome.found, true);
  assert.equal(outcome.hadQuestion, true);
  assert.equal(listPendingInteractions("run-q").length, 0);
  await sleep(5);
  assert.equal(answer, undefined, "the waiting prompt was never released");
  assert.equal(state.finished, true);
});

await check("a turn that ignores the stop is let go of, so the chat is usable again", async () => {
  const state = startTurn("chat-stuck", "run-stuck", { stuck: true });
  const started = Date.now();
  const outcome = await resetChatTurn("chat-stuck", { graceMs: 300 });
  assert.equal(outcome.abandoned, true);
  assert.equal(state.stopRequested, 1);
  assert.ok(Date.now() - started >= 300, "gave up before the grace was over");
  assert.equal(getActiveRun("chat-stuck"), undefined, "the stuck turn is still what the chat says is running");
  assert.equal(getLiveRun("chat-stuck"), null);
});

await check("the next turn in a freed chat is not mistaken for the stuck one", async () => {
  startTurn("chat-reuse", "run-old", { stuck: true });
  await resetChatTurn("chat-reuse", { graceMs: 200 });
  const next = startTurn("chat-reuse", "run-new");
  // The old turn finally unwinds and clears "its" registration: it must not take the new one with it.
  clearActiveRun("chat-reuse", "run-old");
  assert.equal(getActiveRun("chat-reuse")?.runId, "run-new");
  await resetChatTurn("chat-reuse", { graceMs: 500 });
  assert.equal(next.finished, true);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
