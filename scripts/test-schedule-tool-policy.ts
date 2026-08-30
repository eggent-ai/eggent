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
  applySchedulingToolPolicy(s, "покажи список запланированных задач");
  assert.ok(!s.active.includes("Agent"));
  assert.ok(!s.active.includes("bash"));
  assert.ok(s.active.includes("eggent_manage_schedules"));
});

check("a creating turn keeps Agent and withholds only bash", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "напомни мне завтра в 9 утра про задачу");
  assert.ok(s.active.includes("Agent"), "Agent is what creates a schedule");
  assert.ok(!s.active.includes("bash"));
});

check("an ordinary turn gets everything back", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "покажи список запланированных задач");
  applySchedulingToolPolicy(s, "сколько будет два плюс два");
  assert.deepEqual([...s.active].sort(), [...ALL].sort());
});

check("the real sequence that broke: list, then create", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "напомни мне каждый вечер в 21:40 про задачу");
  assert.ok(s.active.includes("Agent"), "first creation");
  applySchedulingToolPolicy(s, "И вообще у тебя есть задача про списанию во всех проектах, то есть там и полностью список.");
  assert.ok(!s.active.includes("Agent"), "the list request withholds it for that turn");
  applySchedulingToolPolicy(s, "Ещё одну разовую задачу. Через три минуты то же самое, напомни мне про самые важные задачи.");
  assert.ok(s.active.includes("Agent"), "and the next creation must have it back");
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
