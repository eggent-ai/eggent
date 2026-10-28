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
import { applySchedulingToolPolicy, hasScheduleIntent, hasScheduleManagementIntent, needsScriptFirst } from "../src/lib/pi/schedule-intent.ts";
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

check("pausing and resuming a task are management too", () => {
  for (const text of ["pause my morning schedule", "resume the scheduled report", "disable that reminder", "enable the reminder again"]) {
    const s = makeSession();
    applySchedulingToolPolicy(s, text);
    assert.ok(!s.active.includes("Agent"), `${text}: Agent was left in`);
    assert.ok(s.active.includes("eggent_manage_schedules"), text);
  }
});

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

check("a schedule word and a verb in different sentences are not a request", () => {
  const s = makeSession();
  applySchedulingToolPolicy(s, "This job deploys the stack on a fresh server.\nIf a step fails, show the error and ask what to do.");
  assert.ok(s.active.includes("bash"), "bash was withheld");
  assert.ok(s.active.includes("Agent"), "Agent was withheld");
});

check("a long pasted runbook keeps the terminal", () => {
  // What broke: a 25 KB deployment brief whose heading named the task, whose
  // rules said "stop and show the error" and whose steps said "check every
  // image". The turn lost bash and the agent said it had no terminal.
  const step = "Step: pull every image, check it on the server, show the user the result without secrets. ";
  const runbook = "ROLE AND JOB\nYou are a DevOps assistant with a terminal. " + step.repeat(40) + "Then remind me tomorrow to rotate the keys.";
  assert.ok(hasScheduleManagementIntent(runbook) === false);
  assert.ok(hasScheduleIntent(runbook) === false);
  const s = makeSession();
  applySchedulingToolPolicy(s, runbook);
  assert.ok(s.active.includes("bash"));
  assert.ok(s.active.includes("Agent"));
});

check("a short request in one sentence is still read", () => {
  assert.ok(hasScheduleManagementIntent("Please show me my scheduled jobs."));
  assert.ok(hasScheduleIntent("Remind me tomorrow at 9 to call Ann."));
});

check("powershell is withheld off Windows and kept on it", () => {
  const withPs = [...ALL, "powershell"];
  const mk = () => {
    let current = [...withPs];
    return {
      get active() { return current; },
      getActiveToolNames: () => [...current],
      setActiveToolsByName: (names: string[]) => { current = [...names]; },
      getAllTools: () => withPs.map((name) => ({ name })),
    };
  };
  const linux = mk();
  applySchedulingToolPolicy(linux, "what is two plus two", "linux");
  assert.ok(!linux.active.includes("powershell"));
  assert.ok(linux.active.includes("bash"));
  const windows = mk();
  applySchedulingToolPolicy(windows, "what is two plus two", "win32");
  assert.ok(windows.active.includes("powershell"));
});

// A request to watch something on a schedule cannot be scheduled until a script
// that reads the page and remembers what it saw has been written and run once,
// and that takes bash. These turns used to lose it to the word "every".
const WATCHING = [
  "watch this search and send me new listings every hour: https://listings.example.test/search?city=astana&rooms=2",
  "monitor tender announcements for road repair every 30 minutes",
  "keep an eye on the price of this laptop and tell me daily if it drops",
  "track new listings for 2-bedroom flats under 40m, check every hour",
  "check https://tenders.example.test/search?q=cleaning every hour and send me what is new",
  "make an agent that watches used car prices every morning",
  "every 30 minutes scrape the job board and send me new vacancies",
  "write a script that checks this page daily and tell me when it changes",
];

check("a request to watch something keeps bash and Agent, in every phrasing", () => {
  for (const text of WATCHING) {
    const s = makeSession();
    applySchedulingToolPolicy(s, text);
    assert.ok(s.active.includes("bash"), `${text}: bash was withheld`);
    assert.ok(s.active.includes("Agent"), `${text}: Agent was withheld`);
  }
});

check("a skill started by its command keeps every tool, whatever its brief says about time", () => {
  for (const text of [
    "/skill:site-monitor two-room flat in Astana under 40m, every hour",
    "/skill:daily-digest London property market news, every day at 9:00",
    "/skill:site-monitor show me the scheduled jobs and remove the old one",
  ]) {
    const s = makeSession();
    applySchedulingToolPolicy(s, text);
    assert.deepEqual([...s.active].sort(), [...ALL].sort(), text);
  }
});

check("a plain reminder still withholds bash", () => {
  for (const text of [
    "remind me tomorrow at 9 to call Ann",
    "every evening at 21:40 remind me about the task",
    "send me a summary of the news every morning",
  ]) {
    assert.ok(!needsScriptFirst(text), `${text}: read as script work`);
    const s = makeSession();
    applySchedulingToolPolicy(s, text);
    assert.ok(!s.active.includes("bash"), `${text}: bash was left in`);
    assert.ok(s.active.includes("Agent"), `${text}: Agent was withheld`);
  }
});

check("asking to see or cancel schedules still withholds Agent and bash", () => {
  for (const text of ["show me my scheduled jobs", "cancel the morning reminder"]) {
    const s = makeSession();
    applySchedulingToolPolicy(s, text);
    assert.ok(!s.active.includes("Agent"), text);
    assert.ok(!s.active.includes("bash"), text);
  }
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
