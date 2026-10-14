import path from "path";
import { Cron } from "croner";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const SCHEDULE_EXECUTION_MARKER = "[Eggent scheduled execution]";

// A run is a helper that starts from nothing: it does not know today's date
// (a morning brief once searched for yesterday and headed itself with
// yesterday), and it spent a turn of its few reading the skill the task was
// written from. What it answers last is what the person is sent.
const SCHEDULE_EXECUTION_DIRECTIVE = [
  SCHEDULE_EXECUTION_MARKER,
  "This schedule has already fired.",
  "Do not create, edit, update, or reschedule scheduled tasks.",
  "Execute the requested work now.",
  "Ignore schedule or timing wording in the stored task; it is context, not a request to configure another schedule.",
  "First learn today's date (run `date`); \"today\", \"the last 24 hours\" and any date you write mean that date, not one found in earlier notes.",
  "The work below is complete as written; do not open skill files to look for more.",
  "Your final answer is what the person receives: make it the finished result itself, not a description of what you did.",
].join("\n");
const SCHEDULED_WORK_SEPARATOR = "\n\nScheduled work:\n";

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
  if (trimmed.startsWith(SCHEDULE_EXECUTION_MARKER)) {
    // A task stored under an older directive gets the current one, so what is
    // learned about runs reaches the tasks people already have. Only the
    // header is replaced; a prompt without the separator is not ours to cut.
    const at = trimmed.indexOf(SCHEDULED_WORK_SEPARATOR);
    if (at < 0 || trimmed.slice(0, at) === SCHEDULE_EXECUTION_DIRECTIVE) return trimmed;
    return `${SCHEDULE_EXECUTION_DIRECTIVE}${trimmed.slice(at)}`;
  }
  return `${SCHEDULE_EXECUTION_DIRECTIVE}${SCHEDULED_WORK_SEPARATOR}${trimmed}`;
}

const TERMINAL_SCHEDULE_HINT = /Manage via \/agents\s*(?:→|->)\s*Scheduled jobs\.?/g;
const EGGENT_SCHEDULE_HINT = "Manage it in Settings → Schedules, or with eggent_manage_schedules.";

/** A tool result with pi's terminal-only pointer replaced by where Eggent keeps tasks. */
export function withEggentScheduleManagement<T>(content: T[]): T[] {
  let changed = false;
  const next = content.map((part) => {
    const text = (part as { type?: unknown; text?: unknown })?.text;
    if ((part as { type?: unknown })?.type !== "text" || typeof text !== "string") return part;
    const replaced = text.replace(TERMINAL_SCHEDULE_HINT, EGGENT_SCHEDULE_HINT);
    if (replaced === text) return part;
    changed = true;
    return { ...(part as object), text: replaced } as T;
  });
  return changed ? next : content;
}

/**
 * The fewest turns a scheduled run is given.
 *
 * A run starts from nothing: reading its notes, a couple of searches, a page
 * or two and writing a file back already take six. Models setting up a task
 * pick small numbers (3 and 6 were seen), and a run stopped at its limit is
 * wrapped up with half the work - a brief of three items out of seven.
 */
export const MIN_SCHEDULED_TURNS = 12;

/** Raises a scheduled Agent call's turn limit to the floor; an unset one is left to the extension. */
export function raiseScheduledTurns(input: Record<string, unknown>): void {
  const turns = input.max_turns;
  if (typeof turns === "number" && Number.isFinite(turns) && turns > 0 && turns < MIN_SCHEDULED_TURNS) {
    input.max_turns = MIN_SCHEDULED_TURNS;
  }
}

/**
 * What the report of a scheduled run is told about its reply.
 *
 * The report turn is the owner session answering the helper's notification,
 * with nobody in it, and its reply is what Eggent sends the person. Left to
 * itself it described the run ("the second run prepared only 3 items") and
 * the brief the person asked for never reached them.
 */
export const SCHEDULED_REPORT_GUIDANCE = [
  "[Eggent: this turn reports a scheduled run]",
  "Nobody is in this turn. Your reply is sent to the person as this run's message, for example in Telegram.",
  "If the run produced what the task asked for (a brief, a summary, a list, a draft), your reply is that result itself, complete and unchanged; fetch it with get_subagent_result first if it is not shown in full. Do not describe the run, and do not comment on how many items it found.",
  "Only if the run produced nothing usable, say in one or two plain sentences what did not work.",
].join("\n");

type ContextMessage = { role?: unknown; customType?: unknown; content?: unknown };

/** The messages of a report turn with the guidance after the run's notification. */
export function withScheduledReportGuidance<T>(messages: T[]): T[] {
  let at = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ContextMessage;
    if (message?.role === "custom" && message.customType === "subagent-notification") {
      at = index;
      break;
    }
  }
  if (at < 0) return messages;
  const message = messages[at] as ContextMessage;
  const content = message.content;
  let next: unknown;
  if (typeof content === "string") {
    if (content.includes(SCHEDULED_REPORT_GUIDANCE)) return messages;
    next = `${content}\n\n${SCHEDULED_REPORT_GUIDANCE}`;
  } else if (Array.isArray(content)) {
    if (content.some((part) => (part as { text?: unknown })?.text === SCHEDULED_REPORT_GUIDANCE)) return messages;
    next = [...content, { type: "text", text: SCHEDULED_REPORT_GUIDANCE }];
  } else {
    return messages;
  }
  const copy = [...messages];
  copy[at] = { ...(message as object), content: next } as T;
  return copy;
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

/**
 * The rules every session carries about scheduled tasks.
 *
 * `inScheduledRun` says whether a session is writing the report of a scheduled
 * run. It is given rather than imported because this file is also loaded by a
 * test that runs without the application's path aliases.
 */
export function createSchedulePolicyExtension(
  inScheduledRun: (sessionId: string | undefined) => boolean,
  refusal: string
): InlineExtension {
  return {
    name: "eggent-schedule-policy",
    hidden: true,
    factory: (pi) => {
      // Every model call of a report turn sees the guidance; it is added to
      // what is sent, never to what is stored.
      pi.on("context", (event, ctx) => {
        if (!inScheduledRun(ctx.sessionManager?.getSessionId?.())) return undefined;
        const messages = withScheduledReportGuidance(event.messages);
        return messages === event.messages ? undefined : { messages };
      });

      // The extension tells the model to manage a task "via /agents", a command
      // of pi's terminal interface that Eggent does not have, and the model
      // passes it on to the person.
      pi.on("tool_result", (event) => {
        if (event.toolName.toLowerCase() !== "agent") return undefined;
        const content = withEggentScheduleManagement(event.content);
        return content === event.content ? undefined : { content };
      });

      pi.on("tool_call", (event, ctx) => {
        const toolName = event.toolName.toLowerCase();
        const input = event.input as Record<string, unknown>;

        if (toolName === "agent") {
          const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
          const prompt = typeof input.prompt === "string" ? input.prompt : "";
          // The report of a scheduled run has every tool and no person in it; a
          // task made from there would be one nobody asked for.
          if (schedule && inScheduledRun(ctx.sessionManager?.getSessionId?.())) {
            return { block: true, reason: refusal };
          }
          if (schedule && prompt) {
            input.prompt = withScheduleExecutionDirective(prompt);
          }
          if (schedule) raiseScheduledTurns(input);
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
}

/** No session is a scheduled run as far as this one knows: the plain rules, for tests. */
export const eggentSchedulePolicyExtension: InlineExtension = createSchedulePolicyExtension(() => false, "");
