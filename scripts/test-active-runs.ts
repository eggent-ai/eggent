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
  stopActiveRun,
} from "../src/lib/pi/active-runs.ts";
import { SUPPORTED_LOCALES } from "../src/i18n/locales.ts";

/**
 * A build understands the languages it ships in and no others, so the Russian
 * half of these expectations flips with the locale set. Asserting it either way
 * is what proves the vocabulary move did not quietly drop a language.
 */
const shipsRussian = (SUPPORTED_LOCALES as readonly string[]).includes("ru");

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

check("a bare stop, with or without punctuation", () => {
  for (const phrase of ["stop", "Stop.", "STOP!", "cancel", "abort", "wait", "enough", "stop it"]) {
    assert.equal(isStopRequest(phrase), true, `should stop on: ${phrase}`);
  }
});

check(`Russian is recognised only in a build that ships it (ru: ${shipsRussian})`, () => {
  for (const phrase of ["стоп", "Стоп", "СТОП!", "стоп.", "хватит", "отмена", "прекрати", "остановись"]) {
    assert.equal(isStopRequest(phrase), shipsRussian, `mismatch on: ${phrase}`);
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

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Stopping used to mean dropping the HTTP request, which is also what closing a
 * tab does - so the two could not be told apart and only one of them meant stop.
 * It is asked for explicitly now, and a run that knows how to wind itself down
 * is asked to do that rather than having its session pulled from underneath: a
 * turn stopped before it wrote anything otherwise looks exactly like a turn the
 * provider never answered, and gets reported as a broken provider.
 */
await checkAsync("a run that knows how to stop itself is asked to", async () => {
  const { session, calls } = fakeSession();
  let requested = 0;
  registerActiveRun("chat-e", {
    session,
    runId: "run-4",
    surface: "web",
    requestStop: () => {
      requested += 1;
    },
  });

  assert.equal(await stopActiveRun("chat-e"), true);
  assert.equal(requested, 1);
  assert.equal(calls.length, 0, "the session is not aborted behind the run's back");
  clearActiveRun("chat-e", "run-4");
});

await checkAsync("a run with no opinion is aborted and dropped", async () => {
  const { session, calls } = fakeSession();
  registerActiveRun("chat-f", { session, runId: "run-5", surface: "external" });

  assert.equal(await stopActiveRun("chat-f"), true);
  assert.deepEqual(calls, ["abort"]);
  assert.equal(getActiveRun("chat-f"), undefined);
});

await checkAsync("stopping a chat that is not working says so", async () => {
  assert.equal(await stopActiveRun("nobody"), false);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
