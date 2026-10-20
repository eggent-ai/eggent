/**
 * When a turn that has gone quiet is given up on.
 *
 * The clock is the test's, so a six-minute rule takes no six minutes. Run with
 * Node 22: npm run test:turn-watchdog
 */
import assert from "node:assert/strict";
import { noteSessionEvent, startTurnWatchdog, watchdogThresholds, type WatchdogThresholds } from "../src/lib/pi/turn-watchdog.ts";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const limits: WatchdogThresholds = { softMs: 90_000, startingMs: 3 * MIN, modelMs: 6 * MIN, toolMs: 20 * MIN, questionMs: 24 * HOUR };

function make(extra: { waiting?: () => boolean; thresholds?: Partial<WatchdogThresholds> } = {}) {
  let time = 1_000_000;
  const soft: Array<{ phase: string; silentMs: number }> = [];
  const stalls: Array<{ phase: string; silentMs: number; unanswered?: boolean }> = [];
  const watchdog = startTurnWatchdog({
    thresholds: { ...limits, ...extra.thresholds },
    isWaitingForHuman: extra.waiting,
    onSoft: (phase, silentMs) => soft.push({ phase, silentMs }),
    onStall: (stalled) => stalls.push(stalled),
    now: () => time,
    tickMs: 0,
  });
  return {
    watchdog,
    soft,
    stalls,
    advance(ms: number) {
      time += ms;
      watchdog.check();
    },
  };
}

console.log("Silence, phase by phase\n");

check("a turn still being set up is given up on after three minutes", () => {
  const t = make();
  t.advance(2 * MIN + 59_000);
  assert.equal(t.stalls.length, 0);
  t.advance(2_000);
  assert.deepEqual(t.stalls.map((s) => s.phase), ["starting"]);
});

check("one waiting for the model gets six", () => {
  const t = make();
  t.watchdog.setPhase("model");
  t.advance(5 * MIN + 59_000);
  assert.equal(t.stalls.length, 0);
  t.advance(2_000);
  assert.deepEqual(t.stalls.map((s) => s.phase), ["model"]);
});

check("one running a command gets twenty: a render is not a hang", () => {
  const t = make();
  t.watchdog.setPhase("tool");
  t.advance(19 * MIN);
  assert.equal(t.stalls.length, 0);
  t.advance(2 * MIN);
  assert.deepEqual(t.stalls.map((s) => s.phase), ["tool"]);
});

check("every event is speech, so a turn that keeps talking is never stopped", () => {
  const t = make();
  t.watchdog.setPhase("model");
  for (let i = 0; i < 20; i += 1) {
    t.advance(4 * MIN);
    t.watchdog.touch();
  }
  assert.equal(t.stalls.length, 0);
});

check("a turn is given up on once, however long it goes on being silent", () => {
  const t = make();
  t.advance(4 * MIN);
  t.advance(30 * MIN);
  assert.equal(t.stalls.length, 1);
  assert.equal(t.watchdog.stalled?.phase, "starting");
});

console.log("\nThe word before the stop\n");

check("after ninety seconds the person is told it is still going, once", () => {
  const t = make();
  t.watchdog.setPhase("model");
  t.advance(80_000);
  assert.equal(t.soft.length, 0);
  t.advance(15_000);
  assert.equal(t.soft.length, 1);
  t.advance(30_000);
  assert.equal(t.soft.length, 1, "told twice for one silence");
  assert.equal(t.stalls.length, 0);
});

check("a new silence is told again after the turn has spoken", () => {
  const t = make();
  t.watchdog.setPhase("model");
  t.advance(100_000);
  t.watchdog.touch();
  t.advance(100_000);
  assert.equal(t.soft.length, 2);
});

console.log("\nWaiting for the person\n");

check("a turn with a question open is waiting, not stuck", () => {
  let open = true;
  const t = make({ waiting: () => open });
  t.watchdog.setPhase("model");
  t.advance(60 * MIN);
  assert.equal(t.stalls.length, 0);
  assert.equal(t.soft.length, 0);
  open = false;
  // The clock starts when the answer arrives, not before.
  t.advance(5 * MIN);
  assert.equal(t.stalls.length, 0);
  t.advance(2 * MIN);
  assert.equal(t.stalls.length, 1);
});

check("a question nobody answers for a day ends the turn, and says it was the question", () => {
  const t = make({ waiting: () => true });
  t.watchdog.toolStarted("ask-1");
  t.advance(23 * HOUR + 59 * MIN);
  assert.equal(t.stalls.length, 0, "stopped before the day was out");
  t.advance(2 * MIN);
  assert.equal(t.stalls.length, 1);
  assert.equal(t.stalls[0].unanswered, true);
  assert.ok(t.stalls[0].silentMs >= 24 * HOUR, `waited ${t.stalls[0].silentMs}`);
  t.advance(24 * HOUR);
  assert.equal(t.stalls.length, 1, "a turn is given up on once");
});

check("an answer starts the next question's day afresh", () => {
  let open = true;
  const t = make({ waiting: () => open });
  t.advance(23 * HOUR);
  open = false;
  t.watchdog.setPhase("model");
  t.advance(MIN);
  open = true;
  t.advance(23 * HOUR);
  assert.equal(t.stalls.length, 0, "the first question's wait was carried into the second");
  t.advance(2 * HOUR);
  assert.equal(t.stalls.length, 1);
  assert.equal(t.stalls[0].unanswered, true);
});

check("a question asked straight after an answer gets a day of its own, even with no look in between", () => {
  const t = make({ waiting: () => true });
  t.watchdog.toolStarted("ask-1");
  t.advance(20 * HOUR);
  // The answer comes back and the next question is asked before the watchdog looks again.
  t.watchdog.toolEnded("ask-1");
  t.watchdog.toolStarted("ask-2");
  t.advance(5 * HOUR);
  assert.equal(t.stalls.length, 0, "the first question's wait was carried into the second");
  t.advance(19 * HOUR + MIN);
  assert.equal(t.stalls.length, 1);
  assert.equal(t.stalls[0].unanswered, true);
});

check("a deployment can let a question wait for ever", () => {
  const t = make({ waiting: () => true, thresholds: { questionMs: 0 } });
  t.advance(30 * 24 * HOUR);
  assert.equal(t.stalls.length, 0);
});

console.log("\nReading the session\n");

check("a tool starting and ending moves the phase, and any other event is speech", () => {
  const t = make();
  noteSessionEvent(t.watchdog, { type: "agent_start" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_start" });
  t.advance(19 * MIN);
  assert.equal(t.stalls.length, 0, "a tool gets the tool allowance");
  noteSessionEvent(t.watchdog, { type: "tool_execution_end" });
  t.advance(5 * MIN);
  assert.equal(t.stalls.length, 0, "and the model gets its own from the moment the tool ends");
  noteSessionEvent(t.watchdog, { type: "message_update" });
  t.advance(5 * MIN);
  assert.equal(t.stalls.length, 0);
});

check("two commands side by side: the quick one ending does not shorten the slow one's allowance", () => {
  const t = make();
  noteSessionEvent(t.watchdog, { type: "agent_start" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_start", toolCallId: "quick" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_start", toolCallId: "build" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_end", toolCallId: "quick" });
  t.advance(7 * MIN);
  assert.equal(t.stalls.length, 0, "a silent build was given up on as a model that had gone quiet");
  t.advance(12 * MIN);
  assert.equal(t.stalls.length, 0, "...and it still has the tool allowance");
  noteSessionEvent(t.watchdog, { type: "tool_execution_end", toolCallId: "build" });
  t.advance(5 * MIN);
  assert.equal(t.stalls.length, 0, "with no tool left the model has its own allowance, from this moment");
  t.advance(2 * MIN);
  assert.deepEqual(t.stalls.map((stall) => stall.phase), ["model"]);
});

check("a tool that began is waited for even when it began after the first one ended", () => {
  const t = make();
  noteSessionEvent(t.watchdog, { type: "tool_execution_start", toolCallId: "a" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_end", toolCallId: "a" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_start", toolCallId: "b" });
  t.advance(10 * MIN);
  assert.equal(t.stalls.length, 0);
});

check("commands that do not say which they are are counted all the same", () => {
  const t = make();
  noteSessionEvent(t.watchdog, { type: "tool_execution_start" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_start" });
  noteSessionEvent(t.watchdog, { type: "tool_execution_end" });
  t.advance(8 * MIN);
  assert.equal(t.stalls.length, 0, "one is still running");
  noteSessionEvent(t.watchdog, { type: "tool_execution_end" });
  t.advance(5 * MIN);
  assert.equal(t.stalls.length, 0);
  t.advance(2 * MIN);
  assert.equal(t.stalls.length, 1);
});

check("an end with no start does not strand the turn in its tool phase, and a new turn forgets a tool that never ended", () => {
  const t = make();
  noteSessionEvent(t.watchdog, { type: "tool_execution_end", toolCallId: "stray" });
  t.advance(7 * MIN);
  assert.equal(t.stalls.length, 1, "the stray end left the turn waiting on a tool that was never running");
  const u = make();
  noteSessionEvent(u.watchdog, { type: "tool_execution_start", toolCallId: "lost" });
  noteSessionEvent(u.watchdog, { type: "turn_start" });
  u.advance(7 * MIN);
  assert.equal(u.stalls.length, 1, "a tool whose end never came kept the next model call on the tool allowance");
});

check("the limits come from the environment, and the watchdog can be switched off", () => {
  assert.deepEqual(watchdogThresholds({}), { softMs: 90_000, startingMs: 180_000, modelMs: 360_000, toolMs: 1_200_000, questionMs: 86_400_000 });
  assert.equal(watchdogThresholds({ EGGENT_TURN_QUESTION_WAIT_SECONDS: "3600" })?.questionMs, 3_600_000);
  assert.equal(watchdogThresholds({ EGGENT_TURN_QUESTION_WAIT_SECONDS: "0" })?.questionMs, 0);
  assert.equal(watchdogThresholds({ EGGENT_TURN_QUESTION_WAIT_SECONDS: "off" })?.questionMs, 0);
  assert.equal(watchdogThresholds({ EGGENT_TURN_QUESTION_WAIT_SECONDS: "a while" })?.questionMs, 86_400_000);
  assert.equal(watchdogThresholds({ EGGENT_TURN_SILENCE_MODEL_SECONDS: "600" })?.modelMs, 600_000);
  assert.equal(watchdogThresholds({ EGGENT_TURN_SILENCE_MODEL_SECONDS: "soon" })?.modelMs, 360_000);
  assert.equal(watchdogThresholds({ EGGENT_TURN_WATCHDOG: "off" }), null);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
