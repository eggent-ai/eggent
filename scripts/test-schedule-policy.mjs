import assert from "node:assert/strict";
import {
  bashReferencesScheduleStore,
  detectSchedule,
  eggentSchedulePolicyExtension,
  isScheduleStorePath,
  SCHEDULE_EXECUTION_MARKER,
  withScheduleExecutionDirective,
} from "../src/lib/pi/schedule-policy.ts";

const cron = detectSchedule("0 4 10 * * *");
assert.equal(cron.scheduleType, "cron");
assert.equal(cron.schedule, "0 4 10 * * *");
assert.ok(cron.nextRun && new Date(cron.nextRun).getTime() > Date.now());
assert.throws(() => detectSchedule("4 10 * * *"), /6 fields/);
const interval = detectSchedule("5m");
assert.equal(interval.scheduleType, "interval");
assert.equal(interval.intervalMs, 300_000);
const relative = detectSchedule("+10m");
assert.equal(relative.scheduleType, "once");
assert.ok(new Date(relative.schedule).getTime() > Date.now());

const originalPrompt = "Send the report to Telegram.";
const normalized = withScheduleExecutionDirective(originalPrompt);
assert.ok(normalized.startsWith(SCHEDULE_EXECUTION_MARKER));
assert.match(normalized, /Execute the requested work now/);
assert.equal(withScheduleExecutionDirective(normalized), normalized);

assert.equal(isScheduleStorePath(".pi/subagent-schedules/chat.json", "/workspace"), true);
assert.equal(isScheduleStorePath("../.pi/subagent-schedules/chat.json", "/workspace/project"), true);
assert.equal(isScheduleStorePath("notes/schedule.json", "/workspace"), false);
assert.equal(bashReferencesScheduleStore("printf x > .pi/subagent-schedules/a.json"), true);
assert.equal(bashReferencesScheduleStore("ls .pi/subagent-schedules"), true);
assert.equal(bashReferencesScheduleStore("echo harmless"), false);

let toolCallHandler;
const extension = eggentSchedulePolicyExtension;
assert.equal(typeof extension, "object");
extension.factory({
  on(event, handler) {
    if (event === "tool_call") toolCallHandler = handler;
  },
});
assert.equal(typeof toolCallHandler, "function");

const scheduledAgent = {
  toolName: "Agent",
  input: { schedule: "0 4 10 * * *", prompt: originalPrompt },
};
assert.equal(toolCallHandler(scheduledAgent, { cwd: "/workspace" }), undefined);
assert.ok(scheduledAgent.input.prompt.startsWith(SCHEDULE_EXECUTION_MARKER));

const blockedWrite = toolCallHandler(
  { toolName: "write", input: { path: ".pi/subagent-schedules/a.json" } },
  { cwd: "/workspace" }
);
assert.equal(blockedWrite?.block, true);

const blockedEdit = toolCallHandler(
  { toolName: "edit", input: { path: "/workspace/.pi/subagent-schedules/a.json" } },
  { cwd: "/workspace" }
);
assert.equal(blockedEdit?.block, true);

const blockedBash = toolCallHandler(
  { toolName: "bash", input: { command: "python update-subagent-schedules.py" } },
  { cwd: "/workspace" }
);
assert.equal(blockedBash?.block, true);

assert.equal(
  toolCallHandler({ toolName: "write", input: { path: "notes/report.md" } }, { cwd: "/workspace" }),
  undefined
);

console.log("schedule policy tests passed");
