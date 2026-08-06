import path from "path";
import { Cron } from "croner";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const SCHEDULE_EXECUTION_MARKER = "[Eggent scheduled execution]";

const SCHEDULE_EXECUTION_DIRECTIVE = [
  SCHEDULE_EXECUTION_MARKER,
  "This schedule has already fired.",
  "Do not create, edit, update, or reschedule scheduled tasks.",
  "Execute the requested work now.",
  "Ignore schedule or timing wording in the stored task; it is context, not a request to configure another schedule.",
].join("\n");

const SCHEDULE_STORE_SEGMENT = "/.pi/subagent-schedules";
const SCHEDULE_GUARD_REASON =
  "Schedule stores are managed by Eggent. Use eggent_manage_schedules with list, update, or clear instead of editing .pi/subagent-schedules directly.";

export function detectSchedule(schedule: string): {
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  intervalMs?: number;
  nextRun?: string;
} {
  const value = schedule.trim();
  if (!value) throw new Error("schedule is required");

  const relative = value.match(/^\+(\d+)(s|m|h|d)$/);
  if (relative) {
    const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
    const nextRun = new Date(Date.now() + Number.parseInt(relative[1], 10) * multiplier).toISOString();
    return { schedule: nextRun, scheduleType: "once", nextRun };
  }

  const interval = value.match(/^(\d+)(s|m|h|d)$/);
  if (interval) {
    const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[interval[2] as "s" | "m" | "h" | "d"];
    const intervalMs = Number.parseInt(interval[1], 10) * multiplier;
    return {
      schedule: value,
      scheduleType: "interval",
      intervalMs,
      nextRun: new Date(Date.now() + intervalMs).toISOString(),
    };
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const target = new Date(value);
    if (Number.isNaN(target.getTime())) throw new Error(`Invalid scheduled timestamp: ${value}`);
    if (target.getTime() <= Date.now()) throw new Error(`Scheduled time ${target.toISOString()} is in the past`);
    return { schedule: target.toISOString(), scheduleType: "once", nextRun: target.toISOString() };
  }

  if (value.split(/\s+/).length !== 6) {
    throw new Error("Cron schedules must use 6 fields: second minute hour day-of-month month day-of-week");
  }

  const cron = new Cron(value, { paused: true });
  try {
    return { schedule: value, scheduleType: "cron", nextRun: cron.nextRun()?.toISOString() };
  } finally {
    cron.stop();
  }
}

export function withScheduleExecutionDirective(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.startsWith(SCHEDULE_EXECUTION_MARKER)) return trimmed;
  return `${SCHEDULE_EXECUTION_DIRECTIVE}\n\nScheduled work:\n${trimmed}`;
}

export function isScheduleStorePath(rawPath: string, cwd: string): boolean {
  if (!rawPath.trim()) return false;
  const resolved = path.resolve(cwd, rawPath).replaceAll("\\", "/");
  return resolved === SCHEDULE_STORE_SEGMENT
    || resolved.endsWith(SCHEDULE_STORE_SEGMENT)
    || resolved.includes(`${SCHEDULE_STORE_SEGMENT}/`);
}

export function bashReferencesScheduleStore(command: string): boolean {
  return command.replaceAll("\\", "/").toLowerCase().includes("subagent-schedules");
}

export const eggentSchedulePolicyExtension: InlineExtension = {
  name: "eggent-schedule-policy",
  hidden: true,
  factory: (pi) => {
    pi.on("tool_call", (event, ctx) => {
      const toolName = event.toolName.toLowerCase();
      const input = event.input as Record<string, unknown>;

      if (toolName === "agent") {
        const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        if (schedule && prompt) {
          input.prompt = withScheduleExecutionDirective(prompt);
        }
        return undefined;
      }

      if (toolName === "write" || toolName === "edit") {
        const targetPath = typeof input.path === "string" ? input.path : "";
        if (targetPath && isScheduleStorePath(targetPath, ctx.cwd)) {
          return { block: true, reason: SCHEDULE_GUARD_REASON };
        }
        return undefined;
      }

      if (toolName === "bash") {
        const command = typeof input.command === "string" ? input.command : "";
        if (command && bashReferencesScheduleStore(command)) {
          return { block: true, reason: SCHEDULE_GUARD_REASON };
        }
      }

      return undefined;
    });
  },
};
