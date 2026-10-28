import { randomUUID } from "node:crypto";

/**
 * An event as a calendar file (.ics, RFC 5545).
 *
 * Opened on a phone, the file goes straight into the person's own calendar -
 * Apple's, Google's or Outlook's - with no account to connect, so it is the way
 * to "put it in my calendar" that works everywhere, a self-hosted workspace
 * included. The agent hands it over through Telegram or as a link in the
 * answer; the download route serves it as text/calendar so a phone offers to
 * add it rather than saving a file nobody opens.
 *
 * Times are what goes wrong in these files, quietly: an event an hour off is
 * still an event. So a time is one of three things, decided by how it is
 * written - an instant (`...Z` or `+03:00`), a wall-clock time in a named zone
 * (`2026-11-03T15:00` with `timeZone`), or a wall-clock time with no zone,
 * which the person's own device reads as local time - and a day without a time
 * is a whole-day event.
 */

export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

export const MAX_EVENTS_PER_FILE = 50;
const MAX_TEXT_CHARS = 4000;
const MAX_REMINDERS = 5;
/** How far ahead a repeating event in a zone with clock changes has those changes written out. */
const TIMEZONE_HORIZON_YEARS = 5;

export interface CalendarEventInput {
  title: string;
  /** `2026-11-03` (a whole day), `2026-11-03T15:00` (wall clock) or `2026-11-03T15:00:00+03:00` / `...Z` (an instant). */
  start: string;
  /** Written the same way as `start`; for a whole day, the last day it covers. */
  end?: string;
  /** Length when `end` is absent. A timed event lasts an hour, a whole-day one a day. */
  durationMinutes?: number;
  /** IANA zone (`Europe/Berlin`) that a wall-clock start and end are in. */
  timeZone?: string;
  location?: string;
  description?: string;
  /** http(s) only. */
  url?: string;
  /** Minutes before the start; several reminders are several alarms. */
  reminderMinutes?: number | number[];
  /** `daily`, `weekly`, `monthly`, `yearly`, or an RRULE body such as `FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10`. */
  repeat?: string;
}

export interface CalendarEventSummary {
  uid: string;
  title: string;
  allDay: boolean;
  /** How the start was written into the file: `utc`, `zone` (with its rules) or `floating`. */
  timing: "utc" | "zone" | "floating" | "date";
  /** ISO instant for utc/zone events, the wall clock for floating ones, the date for whole days. */
  start: string;
  end: string;
  repeat?: string;
}

export interface CalendarFile {
  text: string;
  events: CalendarEventSummary[];
}

export class CalendarInputError extends Error {}

type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

type ParsedTime =
  | { kind: "date"; wall: WallTime }
  | { kind: "instant"; ms: number }
  | { kind: "wall"; wall: WallTime };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function validWall(wall: WallTime): boolean {
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.hour > 23 || wall.minute > 59 || wall.second > 59) return false;
  const probe = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  return probe.getUTCFullYear() === wall.year && probe.getUTCMonth() === wall.month - 1 && probe.getUTCDate() === wall.day;
}

export function parseCalendarTime(raw: string, field: string): ParsedTime {
  const value = String(raw ?? "").trim();
  const date = DATE_RE.exec(value);
  if (date) {
    const wall = { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]), hour: 0, minute: 0, second: 0 };
    if (!validWall(wall)) throw new CalendarInputError(`${field} is not a real date: ${value}`);
    return { kind: "date", wall };
  }
  const match = DATETIME_RE.exec(value);
  if (!match) {
    throw new CalendarInputError(`${field} must look like 2026-11-03, 2026-11-03T15:00 or 2026-11-03T15:00:00+03:00 (got "${value}").`);
  }
  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  if (!validWall(wall)) throw new CalendarInputError(`${field} is not a real time: ${value}`);
  const zone = match[7];
  if (!zone) return { kind: "wall", wall };
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  if (zone.toUpperCase() === "Z") return { kind: "instant", ms: asUtc };
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
  if (offsetMinutes > 14 * 60) throw new CalendarInputError(`${field} has an offset no place uses: ${zone}`);
  return { kind: "instant", ms: asUtc - sign * offsetMinutes * 60_000 };
}

/** Whether `timeZone` is a zone this runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone);
  } catch {
    return false;
  }
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at an instant, in milliseconds. */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  let format = offsetFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant a wall-clock time in a zone names. A time the clocks skip (02:30
 * on the spring-forward night) comes out an hour later, as calendars read it;
 * a time that happens twice is its first occurrence.
 */
export function wallTimeToInstant(wall: WallTime, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const before = zoneOffsetMs(asUtc - 86_400_000, timeZone);
  const after = zoneOffsetMs(asUtc + 86_400_000, timeZone);
  const candidates = [asUtc - before, asUtc - after];
  for (const candidate of candidates.sort((a, b) => a - b)) {
    if (candidate + zoneOffsetMs(candidate, timeZone) === asUtc) return candidate;
  }
  // Skipped by a clock change: read with the offset in force before it.
  return asUtc - before;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function utcStamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function wallStamp(wall: WallTime): string {
  return `${wall.year}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`;
}

function dateStamp(wall: WallTime): string {
  return `${wall.year}${pad(wall.month)}${pad(wall.day)}`;
}

function wallOf(ms: number): WallTime {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function wallMs(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function isoWall(wall: WallTime): string {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function isoDate(wall: WallTime): string {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks escaped, other control characters gone. */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Lines longer than 75 octets continue on the next line after a space. Counted
 * in UTF-8 bytes and never cut inside a character, or a Cyrillic title breaks
 * into replacement marks in the calendar that reads it.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf-8") <= 75) return line;
  const pieces: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf-8");
    if (bytes + size > limit) {
      pieces.push(current);
      current = "";
      bytes = 0;
      // A continuation line starts with the space that marks it.
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  if (current) pieces.push(current);
  return pieces.join("\r\n ");
}

const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const RULE_PARTS: Record<string, RegExp> = {
  FREQ: /^(DAILY|WEEKLY|MONTHLY|YEARLY)$/,
  INTERVAL: /^[1-9]\d{0,2}$/,
  COUNT: /^[1-9]\d{0,3}$/,
  UNTIL: /^\d{8}(T\d{6}Z?)?$/,
  BYDAY: /^([+-]?[1-5]?(MO|TU|WE|TH|FR|SA|SU))(,[+-]?[1-5]?(MO|TU|WE|TH|FR|SA|SU))*$/,
  BYMONTHDAY: /^(-?(?:[1-9]|[12]\d|3[01]))(,-?(?:[1-9]|[12]\d|3[01]))*$/,
  BYMONTH: /^(?:[1-9]|1[0-2])(,(?:[1-9]|1[0-2]))*$/,
  BYSETPOS: /^-?[1-5]$/,
  WKST: /^(MO|TU|WE|TH|FR|SA|SU)$/,
};

/** A repetition rule calendars agree on, or an error naming what was not understood. */
export function normalizeRepeat(raw: string): string {
  const value = raw.trim().replace(/^RRULE:/i, "").toUpperCase();
  if (FREQUENCIES.has(value)) return `FREQ=${value}`;
  const seen = new Set<string>();
  const parts = value.split(";").filter(Boolean);
  for (const part of parts) {
    const [key, ruleValue, extra] = part.split("=");
    const pattern = RULE_PARTS[key];
    if (!pattern || extra !== undefined || ruleValue === undefined || !pattern.test(ruleValue)) {
      throw new CalendarInputError(`repeat: "${part}" is not a rule this file can carry. Use daily, weekly, monthly, yearly, or FREQ=WEEKLY;BYDAY=MO;COUNT=10.`);
    }
    if (seen.has(key)) throw new CalendarInputError(`repeat: ${key} is given twice.`);
    seen.add(key);
  }
  if (!seen.has("FREQ")) throw new CalendarInputError("repeat needs FREQ (DAILY, WEEKLY, MONTHLY or YEARLY).");
  if (seen.has("COUNT") && seen.has("UNTIL")) throw new CalendarInputError("repeat: COUNT and UNTIL cannot both be given.");
  return parts.join(";");
}

/**
 * UNTIL written the way the start is (RFC 5545 3.3.10): a date for a whole-day
 * event, UTC for a timed one, local for a floating one. Calendars refuse or
 * misread a rule whose end is written differently from its start.
 */
function untilMatchingStart(rule: string, timing: CalendarEventSummary["timing"]): string {
  return rule.replace(/(^|;)UNTIL=(\d{8})(T\d{6})?Z?/, (_all, lead: string, date: string, time: string | undefined) => {
    if (timing === "date") return `${lead}UNTIL=${date}`;
    const clock = time ?? "T235959";
    return timing === "floating" ? `${lead}UNTIL=${date}${clock}` : `${lead}UNTIL=${date}${clock}Z`;
  });
}

function offsetText(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const minutes = Math.abs(Math.round(ms / 60_000));
  return `${sign}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
}

/**
 * The zone's own rules for the file, written out as the clock changes it will
 * go through: a repeating event in a named zone has to stay at 10:00 when the
 * clocks change, which an event pinned to UTC would not.
 */
export function timeZoneBlock(timeZone: string, fromMs: number, untilMs: number): string[] {
  const day = 86_400_000;
  const startDay = Date.UTC(new Date(fromMs).getUTCFullYear(), 0, 1);
  const transitions: Array<{ at: number; from: number; to: number }> = [];
  let previous = zoneOffsetMs(startDay, timeZone);
  for (let t = startDay + day; t <= untilMs + day; t += day) {
    const offset = zoneOffsetMs(t, timeZone);
    if (offset === previous) continue;
    // The second it changed, within the day: the first one with the new offset.
    let low = (t - day) / 1000;
    let high = t / 1000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (zoneOffsetMs(middle * 1000, timeZone) === previous) low = middle;
      else high = middle;
    }
    transitions.push({ at: high * 1000, from: previous, to: offset });
    previous = offset;
  }
  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  const initial = zoneOffsetMs(startDay, timeZone);
  const offsets = [initial, ...transitions.map((item) => item.to)];
  const largest = Math.max(...offsets);
  // Summer time is the larger of the offsets a zone moves between; a zone that never moves has only standard time.
  const kindOf = (offset: number) => (offset === largest && largest !== Math.min(...offsets) ? "DAYLIGHT" : "STANDARD");
  const component = (kind: string, onset: string, from: number, to: number) => [
    `BEGIN:${kind}`,
    `DTSTART:${onset}`,
    `TZOFFSETFROM:${offsetText(from)}`,
    `TZOFFSETTO:${offsetText(to)}`,
    `END:${kind}`,
  ];
  lines.push(...component(kindOf(initial), "19700101T000000", initial, initial));
  for (const transition of transitions) {
    // The onset is the local time just before the change, read with the old offset.
    lines.push(...component(kindOf(transition.to), wallStamp(wallOf(transition.at + transition.from)), transition.from, transition.to));
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function cleanText(value: unknown, field: string, max = MAX_TEXT_CHARS): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new CalendarInputError(`${field} is longer than ${max} characters.`);
  return text;
}

function reminderList(value: CalendarEventInput["reminderMinutes"]): number[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_REMINDERS) throw new CalendarInputError(`At most ${MAX_REMINDERS} reminders per event.`);
  return list.map((minutes) => {
    const number = Number(minutes);
    if (!Number.isInteger(number) || number < 0 || number > 40_320) {
      throw new CalendarInputError("reminderMinutes are whole minutes before the start, up to four weeks.");
    }
    return number;
  });
}

function triggerFor(minutes: number): string {
  if (minutes === 0) return "PT0M";
  if (minutes % 1440 === 0) return `-P${minutes / 1440}D`;
  if (minutes % 60 === 0) return `-PT${minutes / 60}H`;
  return `-PT${minutes}M`;
}

interface BuildOptions {
  now?: Date;
  /** A fixed id generator, for tests. */
  uid?: () => string;
}

/**
 * One file for one or more events. Throws CalendarInputError with a sentence
 * the agent can act on when an event cannot be written truthfully.
 */
export function buildCalendarFile(inputs: CalendarEventInput[], options: BuildOptions = {}): CalendarFile {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new CalendarInputError("Give at least one event.");
  if (inputs.length > MAX_EVENTS_PER_FILE) throw new CalendarInputError(`At most ${MAX_EVENTS_PER_FILE} events in one file.`);
  const stamp = utcStamp((options.now ?? new Date()).getTime());
  const makeUid = options.uid ?? (() => randomUUID());
  const body: string[] = [];
  const zones = new Map<string, { from: number; until: number }>();
  const events: CalendarEventSummary[] = [];

  inputs.forEach((input, index) => {
    const label = inputs.length > 1 ? `Event ${index + 1}: ` : "";
    const title = cleanText(input.title, `${label}title`, 500);
    if (!title) throw new CalendarInputError(`${label}title is required.`);
    const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
    if (timeZone && !isKnownTimeZone(timeZone)) throw new CalendarInputError(`${label}timeZone "${timeZone}" is not a known zone; use a name like Europe/Berlin.`);
    const start = parseCalendarTime(input.start, `${label}start`);
    const end = input.end ? parseCalendarTime(input.end, `${label}end`) : null;
    const repeat = input.repeat ? normalizeRepeat(input.repeat) : undefined;
    const duration = input.durationMinutes === undefined ? null : Number(input.durationMinutes);
    if (duration !== null && (!Number.isInteger(duration) || duration <= 0 || duration > 60 * 24 * 31)) {
      throw new CalendarInputError(`${label}durationMinutes must be a whole number of minutes, at most a month.`);
    }
    const url = cleanText(input.url, `${label}url`, 2000);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new CalendarInputError(`${label}url must start with http:// or https://.`);
    const uid = makeUid();
    const lines = ["BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`];
    let summary: CalendarEventSummary;

    if (start.kind === "date") {
      if (end && end.kind !== "date") throw new CalendarInputError(`${label}a whole-day event ends on a date too.`);
      const lastDay = end ? end.wall : null;
      if (lastDay && wallMs(lastDay) < wallMs(start.wall)) throw new CalendarInputError(`${label}end is before start.`);
      const days = lastDay
        ? Math.round((wallMs(lastDay) - wallMs(start.wall)) / 86_400_000) + 1
        : Math.max(1, Math.round((duration ?? 1440) / 1440));
      // DTEND of a whole-day event is the day after the last one.
      const after = wallOf(wallMs(start.wall) + days * 86_400_000);
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(start.wall)}`, `DTEND;VALUE=DATE:${dateStamp(after)}`);
      summary = { uid, title, allDay: true, timing: "date", start: isoDate(start.wall), end: isoDate(wallOf(wallMs(after) - 86_400_000)) };
    } else {
      if (end && end.kind === "date") throw new CalendarInputError(`${label}an event with a time ends at a time too.`);
      const minutes = duration ?? 60;
      if (start.kind === "wall" && !timeZone) {
        // No zone given: the device that opens the file reads it as its own local time.
        if (end && end.kind === "instant") throw new CalendarInputError(`${label}start and end must both carry an offset, or neither.`);
        const endWall = end ? end.wall : wallOf(wallMs(start.wall) + minutes * 60_000);
        if (wallMs(endWall) <= wallMs(start.wall)) throw new CalendarInputError(`${label}end must be after start.`);
        lines.push(`DTSTART:${wallStamp(start.wall)}`, `DTEND:${wallStamp(endWall)}`);
        summary = { uid, title, allDay: false, timing: "floating", start: isoWall(start.wall), end: isoWall(endWall) };
      } else {
        const startMs = start.kind === "instant" ? start.ms : wallTimeToInstant(start.wall, timeZone);
        let endMs: number;
        if (!end) endMs = startMs + minutes * 60_000;
        else if (end.kind === "instant") endMs = end.ms;
        else if (timeZone) endMs = wallTimeToInstant(end.wall, timeZone);
        else throw new CalendarInputError(`${label}start and end must both carry an offset, or neither.`);
        if (endMs <= startMs) throw new CalendarInputError(`${label}end must be after start.`);
        if (repeat && timeZone) {
          // Kept on the zone's clock, so 10:00 stays 10:00 after the clocks change.
          const local = (ms: number) => wallOf(ms + zoneOffsetMs(ms, timeZone));
          lines.push(`DTSTART;TZID=${timeZone}:${wallStamp(local(startMs))}`, `DTEND;TZID=${timeZone}:${wallStamp(local(endMs))}`);
          const horizon = startMs + TIMEZONE_HORIZON_YEARS * 365 * 86_400_000;
          const known = zones.get(timeZone);
          zones.set(timeZone, { from: Math.min(known?.from ?? startMs, startMs), until: Math.max(known?.until ?? horizon, horizon) });
          summary = { uid, title, allDay: false, timing: "zone", start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
        } else {
          lines.push(`DTSTART:${utcStamp(startMs)}`, `DTEND:${utcStamp(endMs)}`);
          summary = { uid, title, allDay: false, timing: "utc", start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
        }
      }
    }

    lines.push(`SUMMARY:${escapeText(title)}`);
    const location = cleanText(input.location, `${label}location`, 500);
    if (location) lines.push(`LOCATION:${escapeText(location)}`);
    const description = cleanText(input.description, `${label}description`);
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    if (url) lines.push(`URL:${url}`);
    if (repeat) {
      const rule = untilMatchingStart(repeat, summary.timing);
      lines.push(`RRULE:${rule}`);
      summary.repeat = rule;
    }
    for (const minutes of reminderList(input.reminderMinutes)) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(title)}`, `TRIGGER:${triggerFor(minutes)}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
    body.push(...lines);
    events.push(summary);
  });

  const head = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Eggent//Agent//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const [zone, span] of zones) head.push(...timeZoneBlock(zone, span.from, span.until));
  const text = [...head, ...body, "END:VCALENDAR"].map(foldLine).join("\r\n") + "\r\n";
  return { text, events };
}

/** A file name from the event's title: the title as written, minus what a file system refuses. */
export function calendarFileName(title: string): string {
  const base = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    // No leading dots: a hidden file, or what is left of `../`.
    .replace(/^[.\s]+/, "")
    .slice(0, 60)
    .trim();
  return `${base || "event"}.ics`;
}

/** Whether a path names a calendar file. */
export function isCalendarFile(path: string): boolean {
  return /\.ics$/i.test(path);
}
