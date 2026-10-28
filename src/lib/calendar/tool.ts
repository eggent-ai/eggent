/**
 * The agent's tool for putting an event in the person's own calendar without
 * any account: it writes a calendar file, which the person opens on a phone or
 * a computer and the calendar there adds.
 *
 * Every workspace has it, self-hosted ones included. Where a deployment also
 * connects Google (eggent_google), that tool can write into the calendar
 * itself; this one needs nothing but the file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildCalendarFile,
  calendarFileName,
  CalendarInputError,
  isCalendarFile,
  type CalendarEventInput,
  type CalendarEventSummary,
} from "@/lib/calendar/ics";

export const CALENDAR_FILE_TOOL = "eggent_calendar_file";

export interface CalendarFileToolOptions {
  /** Where the file is written; a helper's own working directory when absent. */
  cwd?: string;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Where the file goes: the name asked for (overwritten), else one made from the title that is not taken yet. */
async function targetPath(cwd: string, title: string, asked?: string): Promise<{ absolute: string; relative: string }> {
  const root = path.resolve(cwd);
  if (asked?.trim()) {
    const relative = asked.trim().replace(/^\.\//, "");
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new CalendarInputError("fileName is a path inside your working folder, without .. and not absolute.");
    }
    if (!isCalendarFile(relative)) throw new CalendarInputError("fileName must end with .ics.");
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) throw new CalendarInputError("fileName must stay inside your working folder.");
    const existing = await fs.lstat(absolute).catch(() => null);
    if (existing && !existing.isFile()) throw new CalendarInputError(`${relative} is there and is not a plain file.`);
    return { absolute, relative };
  }
  const base = calendarFileName(title);
  const stem = base.slice(0, -".ics".length);
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const relative = attempt === 1 ? base : `${stem}-${attempt}.ics`;
    const absolute = path.join(root, relative);
    if (!(await fs.lstat(absolute).catch(() => null))) return { absolute, relative };
  }
  throw new CalendarInputError("Too many calendar files with this name here; give fileName.");
}

function describe(event: CalendarEventSummary): Record<string, unknown> {
  return {
    title: event.title,
    ...(event.allDay ? { days: event.start === event.end ? event.start : `${event.start} - ${event.end}` } : { start: event.start, end: event.end }),
    ...(event.timing === "floating" ? { time: "local time of whatever device opens the file" } : {}),
    ...(event.repeat ? { repeat: event.repeat } : {}),
  };
}

const EventSchema = Type.Object({
  title: Type.String({ description: "What the event is called in the calendar." }),
  start: Type.String({ description: "2026-11-03 for a whole day; 2026-11-03T15:00 for a time on the clock of timeZone; 2026-11-03T15:00:00+03:00 for an exact moment." }),
  end: Type.Optional(Type.String({ description: "Written like start. For whole days, the last day." })),
  durationMinutes: Type.Optional(Type.Number({ description: "Length when end is not given; one hour by default." })),
  timeZone: Type.Optional(Type.String({ description: "This event's own zone, when it differs from the file's." })),
  location: Type.Optional(Type.String()),
  description: Type.Optional(Type.String({ description: "Notes shown with the event." })),
  url: Type.Optional(Type.String({ description: "A link shown with the event (http or https)." })),
  reminderMinutes: Type.Optional(Type.Array(Type.Number(), { description: "Reminders, in minutes before the start: [15], [1440, 60]." })),
  repeat: Type.Optional(Type.String({ description: "daily, weekly, monthly, yearly, or a rule such as FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10. Give timeZone with it." })),
});

export function createCalendarFileTool(options: CalendarFileToolOptions) {
  return defineTool({
    name: CALENDAR_FILE_TOOL,
    label: "Calendar File",
    promptSnippet: "a calendar file (.ics) that adds events to the person's own calendar when opened",
    description: "Write a calendar file (.ics) with one or more events. Opened on a phone or a computer, it adds the events to the person's own calendar - Apple, Google, Outlook - with no account connected. Use it when the person wants something in their calendar or wants a reminder they can keep there. Give timeZone (a zone name such as Europe/Berlin) and wall-clock times like 2026-11-03T15:00, ask the person's zone when you do not know it, and give it with any repeating event. Hand the file over by naming it in your answer in backticks - it shows as a link that opens the calendar - or send it with telegram_send_file.",
    parameters: Type.Object({
      events: Type.Array(EventSchema, { minItems: 1, maxItems: 50 }),
      timeZone: Type.Optional(Type.String({ description: "The zone the wall-clock times are in, e.g. Europe/Berlin." })),
      fileName: Type.Optional(Type.String({ description: "Where to write it, inside your working folder, ending .ics; replaces a file of that name. Made from the first title when absent." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const cwd = options.cwd || ctx?.cwd || path.join(process.cwd(), "data", "projects");
      try {
        const inputs: CalendarEventInput[] = params.events.map((event) => ({
          ...event,
          timeZone: event.timeZone?.trim() || params.timeZone?.trim() || undefined,
        }));
        const built = buildCalendarFile(inputs);
        const target = await targetPath(cwd, inputs[0].title, params.fileName);
        await fs.mkdir(path.dirname(target.absolute), { recursive: true });
        await fs.writeFile(target.absolute, built.text, "utf-8");
        return textResult(
          JSON.stringify({
            success: true,
            file: target.relative,
            events: built.events.map(describe),
            note: `Name the file in your answer as \`${target.relative}\`: it becomes a link, and a phone opens it in its calendar. Or send it with telegram_send_file. Tell the person the date and time you put in, so a mistake is caught now.`,
          }, null, 2),
          { file: { path: target.absolute, relative: target.relative, events: built.events.length } }
        );
      } catch (error) {
        if (error instanceof CalendarInputError) {
          return textResult(JSON.stringify({ success: false, error: error.message }, null, 2));
        }
        throw error;
      }
    },
  });
}
