/**
 * Checks which tools survive a scheduling turn.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-schedule-tool-policy.ts
 *
 * Managing schedules and creating them need different tool sets, and the one
 * that must never happen is a set that never recovers: `Agent` is the only tool
 * that creates a schedule, so withholding it for a management turn and not
 * giving it back leaves the conversation permanently unable to schedule
 * anything. That is exactly what happened in a real session - three reminders
 * created, then "show me the list", then "add one more in three minutes" and
 * the model reported the scheduling tool was unavailable.
 */
import assert from "node:assert/strict";
import { applySchedulingToolPolicy } from "../src/lib/pi/schedule-intent.ts";
import { SUPPORTED_LOCALES } from "../src/i18n/locales.ts";

/** The vocabulary a build ships decides which phrasings it can recognise. */
const shipsRussian = (SUPPORTED_LOCALES as readonly string[]).includes("ru");

const ALL = ["Agent", "bash", "read", "write", "eggent_manage_schedules", "telegram_send_message"];

function makeSession(active: string[] = [...ALL]) {
  let current = [...active];
  return {
    get active() {
      return current;
    },
    getActiveToolNames: () => [...current],
    setActiveToolsByName: (names: string[]) => {
      current = [...names];
    },
    getAllTools: () => ALL.map((name) => ({ name })),
    getToolDefinition: (name: string) => (ALL.includes(name) ? {} : undefined),
  };
}

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

console.log("Scheduling tool policy\n");

check("a management turn withholds the tools that would edit the store by hand", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "show me the list of scheduled jobs");
  assert.ok(!s.active.includes("Agent"));
  assert.ok(!s.active.includes("bash"));
  assert.ok(s.active.includes("eggent_manage_schedules"));
});

check("a creating turn keeps Agent and withholds only bash", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "remind me tomorrow about the task");
  assert.ok(s.active.includes("Agent"), "Agent is what creates a schedule");
  assert.ok(!s.active.includes("bash"));
});

check("an ordinary turn gets everything back", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "show me the list of scheduled jobs");
  applySchedulingToolPolicy(s, "what is two plus two");
  assert.deepEqual([...s.active].sort(), [...ALL].sort());
});

check("the real sequence that broke: create, list, create again", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "remind me every evening at 21:40 about the task");
  assert.ok(s.active.includes("Agent"), "first creation");
  applySchedulingToolPolicy(s, "show me the full list of jobs across all projects");
  assert.ok(!s.active.includes("Agent"), "the list request withholds it for that turn");
  applySchedulingToolPolicy(s, "one more one-off, in three minutes, remind me about the most important tasks");
  assert.ok(s.active.includes("Agent"), "and the next creation must have it back");
});

check(`the same sequence in Russian, recognised only where it ships (ru: ${shipsRussian})`, () => {
  // The words the user actually typed when this broke. A build without the
  // Russian vocabulary reads them as ordinary text and withholds nothing.
  const s = makeSession();
  applySchedulingToolPolicy(s, "напомни мне каждый вечер в 21:40 про задачу");
  assert.ok(s.active.includes("Agent"));
  applySchedulingToolPolicy(s, "И вообще у тебя есть задача про списанию во всех проектах, то есть там и полностью список.");
  assert.equal(s.active.includes("Agent"), !shipsRussian, "withheld only where the phrase is understood");
  applySchedulingToolPolicy(s, "Ещё одну разовую задачу. Через три минуты то же самое, напомни мне про самые важные задачи.");
  assert.ok(s.active.includes("Agent"), "and it comes back either way");
});

check("a session that never had a tool does not gain one", () => {
  const s = makeSession(["read", "write"]);
  const limited = {
    ...s,
    getAllTools: () => [{ name: "read" }, { name: "write" }],
    getToolDefinition: (name: string) => (["read", "write"].includes(name) ? {} : undefined),
  };
  applySchedulingToolPolicy(limited, "сколько будет два плюс два");
  assert.ok(!limited.active.includes("Agent"));
  assert.ok(!limited.active.includes("bash"));
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
