/**
 * Checks what happens to a message that arrives while the chat is already working.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-active-runs.ts
 *
 * The failure this replaces: every surface started its own agent, so a chat
 * could hold two at once and neither could reach the other. Typing "stop" while
 * a long run was going produced a second agent that stopped itself and said so,
 * while the real run carried on for another two minutes.
 *
 * The stop vocabulary is the delicate part. It is matched against the whole
 * message and never searched inside one, because a false positive throws away
 * work in progress: "stop" is an instruction, "stop words in the index" is a task.
 */
import assert from "node:assert/strict";
import {
  activeRunCount,
  clearActiveRun,
  getActiveRun,
  isStopRequest,
  registerActiveRun,
} from "../src/lib/pi/active-runs.ts";

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

function fakeSession(isStreaming = true) {
  const calls: string[] = [];
  return {
    calls,
    session: {
      get isStreaming() {
        return isStreaming;
      },
      async abort() {
        calls.push("abort");
      },
      async steer(text: string) {
        calls.push(`steer:${text}`);
      },
    },
  };
}

console.log("Active runs and stop requests\n");

check("a bare stop, in either language, with or without punctuation", () => {
  for (const phrase of ["стоп", "Стоп", "СТОП!", "стоп.", "хватит", "отмена", "прекрати", "остановись",
                        "stop", "Stop.", "STOP!", "cancel", "abort", "wait", "enough", "stop it"]) {
    assert.equal(isStopRequest(phrase), true, `should stop on: ${phrase}`);
  }
});

check("a task that merely contains the word is not a stop", () => {
  for (const phrase of [
    "stop words in the index need cleaning",
    "не останавливайся, продолжай до конца",
    "напиши функцию stop() для плеера",
    "сделай кнопку «Стоп» в интерфейсе",
    "cancel my gym membership and tell me what the reply says",
    "хватит ли памяти на эту модель?",
  ]) {
    assert.equal(isStopRequest(phrase), false, `should not stop on: ${phrase}`);
  }
});

check("an empty or whitespace message is not a stop", () => {
  assert.equal(isStopRequest(""), false);
  assert.equal(isStopRequest("   \n "), false);
});

check("a registered run is found, and cleared by its own id only", () => {
  const { session } = fakeSession();
  registerActiveRun("chat-a", { session, runId: "run-1", surface: "web" });
  assert.ok(getActiveRun("chat-a"), "the run should be reachable");

  // A losing overlapping run must not evict the live one on its way out.
  clearActiveRun("chat-a", "run-0");
  assert.ok(getActiveRun("chat-a"), "a foreign run id must not clear it");

  clearActiveRun("chat-a", "run-1");
  assert.equal(getActiveRun("chat-a"), undefined);
});

check("a session that has stopped streaming is not offered as joinable", () => {
  const { session } = fakeSession(false);
  registerActiveRun("chat-b", { session, runId: "run-2", surface: "external" });
  assert.equal(getActiveRun("chat-b"), undefined, "nothing left to interrupt");
  assert.equal(activeRunCount(), 0, "and it is dropped from the registry");
});

check("chats do not see each other's runs", () => {
  const a = fakeSession();
  registerActiveRun("chat-c", { session: a.session, runId: "run-3", surface: "web" });
  assert.equal(getActiveRun("chat-d"), undefined);
  clearActiveRun("chat-c", "run-3");
});

check("an unknown chat has no run", () => {
  assert.equal(getActiveRun("nobody"), undefined);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
