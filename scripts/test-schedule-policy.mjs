import assert from "node:assert/strict";
import {
  bashReferencesScheduleStore,
  createSchedulePolicyExtension,
  detectSchedule,
  eggentSchedulePolicyExtension,
  isScheduleStorePath,
  SCHEDULE_EXECUTION_MARKER,
  SCHEDULED_REPORT_GUIDANCE,
  withScheduleExecutionDirective,
  withScheduledReportGuidance,
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
// The run is told to learn today's date and that its last answer is what the person gets.
assert.match(normalized, /learn today's date/);
assert.match(normalized, /final answer is what the person receives/);
// A task stored under an older directive gets the current one, its work untouched.
const stored = `${SCHEDULE_EXECUTION_MARKER}\nThis schedule has already fired.\nExecute the requested work now.\n\nScheduled work:\n${originalPrompt}`;
const upgraded = withScheduleExecutionDirective(stored);
assert.equal(upgraded, normalized);
assert.equal(upgraded.split(SCHEDULE_EXECUTION_MARKER).length - 1, 1);
// One with no separator is not ours to cut.
const unusual = `${SCHEDULE_EXECUTION_MARKER} custom`;
assert.equal(withScheduleExecutionDirective(unusual), unusual);

// A report turn: the guidance follows the newest notification, in what is sent only.
const notification = { role: "custom", customType: "subagent-notification", content: "<result>brief</result>" };
const sent = [{ role: "user", content: "x" }, notification];
const guided = withScheduledReportGuidance(sent);
assert.notEqual(guided, sent);
assert.equal(notification.content, "<result>brief</result>", "the stored message must not change");
assert.ok(guided[1].content.endsWith(SCHEDULED_REPORT_GUIDANCE));
assert.equal(withScheduledReportGuidance(guided), guided, "the guidance is added once");
const arrayNote = { role: "custom", customType: "subagent-notification", content: [{ type: "text", text: "r" }] };
assert.equal(withScheduledReportGuidance([arrayNote])[0].content.at(-1).text, SCHEDULED_REPORT_GUIDANCE);
const noNote = [{ role: "user", content: "hi" }];
assert.equal(withScheduledReportGuidance(noNote), noNote);

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

// The report of a scheduled run has every tool and no person in it: a task
// made from there is one nobody asked for.
let runHandler;
createSchedulePolicyExtension((sessionId) => sessionId === "session-in-a-run", "no person is here").factory({
  on(event, handler) {
    if (event === "tool_call") runHandler = handler;
  },
});
const inRun = { cwd: "/workspace", sessionManager: { getSessionId: () => "session-in-a-run" } };
const person = { cwd: "/workspace", sessionManager: { getSessionId: () => "session-with-a-person" } };
const madeInARun = runHandler({ toolName: "Agent", input: { schedule: "5m", prompt: originalPrompt } }, inRun);
assert.equal(madeInARun?.block, true);
assert.equal(madeInARun?.reason, "no person is here");
const madeByAPerson = { toolName: "Agent", input: { schedule: "5m", prompt: originalPrompt } };
assert.equal(runHandler(madeByAPerson, person), undefined);
assert.ok(madeByAPerson.input.prompt.startsWith(SCHEDULE_EXECUTION_MARKER));
// An Agent call with no schedule is an ordinary helper, run or no run.
assert.equal(runHandler({ toolName: "Agent", input: { prompt: "look something up" } }, inRun), undefined);
// A context without a session manager (the plain test above) is not a run.
assert.equal(runHandler({ toolName: "Agent", input: { schedule: "5m", prompt: originalPrompt } }, { cwd: "/workspace" }), undefined);

console.log("schedule policy tests passed");
