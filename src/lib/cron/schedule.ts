import { parseAbsoluteTimeMs } from "@/lib/cron/parse";
import type { CronSchedule } from "@/lib/cron/types";

const MINUTE_MS = 60_000;
const MAX_CRON_LOOKAHEAD_MINUTES = 60 * 24 * 366 * 2; // 2 years

type ZonedDateParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

type CronMatcher = {
  matches: (parts: ZonedDateParts) => boolean;
};

function resolveCronTimezone(tz?: string): string {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (trimmed) {
    return trimmed;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function parseNumberToken(token: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(token)) {
    return null;
  }
  const value = Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function expandRange(
  token: string,
  min: number,
  max: number,
  mapDow7To0: boolean,
): number[] | null {
  const [leftRaw, rightRaw] = token.split("-");
  if (!leftRaw || !rightRaw) {
    return null;
  }
  const left = parseNumberToken(leftRaw, min, max);
  const right = parseNumberToken(rightRaw, min, max);
  if (left === null || right === null || left > right) {
    return null;
  }
  const out: number[] = [];
  for (let value = left; value <= right; value += 1) {
    out.push(mapDow7To0 && value === 7 ? 0 : value);
  }
  return out;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  mapDow7To0: boolean,
): Set<number> | null {
  const trimmed = field.trim();
  if (!trimmed) {
    return null;
  }

  const values = new Set<number>();
  const parts = trimmed.split(",");
  for (const part of parts) {
    const token = part.trim();
    if (!token) {
      return null;
    }

    const [baseRaw, stepRaw] = token.split("/");
    const hasStep = stepRaw !== undefined;
    const step = hasStep ? parseNumberToken(stepRaw, 1, max - min + 1) : 1;
    if (step === null) {
      return null;
    }

    let baseValues: number[] = [];
    if (baseRaw === "*") {
      for (let v = min; v <= max; v += 1) {
        baseValues.push(mapDow7To0 && v === 7 ? 0 : v);
      }
    } else if (baseRaw.includes("-")) {
      const expanded = expandRange(baseRaw, min, max, mapDow7To0);
      if (!expanded) {
        return null;
      }
      baseValues = expanded;
    } else {
      const single = parseNumberToken(baseRaw, min, max);
      if (single === null) {
        return null;
      }
      baseValues = [mapDow7To0 && single === 7 ? 0 : single];
    }

    if (hasStep) {
      const sorted = [...new Set(baseValues)].sort((a, b) => a - b);
      if (sorted.length === 0) {
        return null;
      }
      const start = sorted[0];
      for (const value of sorted) {
        if ((value - start) % step === 0) {
          values.add(value);
        }
      }
      continue;
    }

    for (const value of baseValues) {
      values.add(value);
    }
  }

  return values.size > 0 ? values : null;
}

function parseCronExpr(expr: string): CronMatcher | null {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return null;
  }
  const minute = parseCronField(fields[0], 0, 59, false);
  const hour = parseCronField(fields[1], 0, 23, false);
  const dayOfMonth = parseCronField(fields[2], 1, 31, false);
  const month = parseCronField(fields[3], 1, 12, false);
  const dayOfWeek = parseCronField(fields[4], 0, 7, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }
  return {
    matches(parts: ZonedDateParts) {
      return (
        minute.has(parts.minute) &&
        hour.has(parts.hour) &&
        dayOfMonth.has(parts.dayOfMonth) &&
        month.has(parts.month) &&
        dayOfWeek.has(parts.dayOfWeek)
      );
    },
  };
}

function getZonedDateParts(ms: number, tz: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(new Date(ms));
  let minute = 0;
  let hour = 0;
  let dayOfMonth = 0;
  let month = 0;
  let weekdayRaw = "";
  for (const part of parts) {
    if (part.type === "minute") minute = Number(part.value);
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "day") dayOfMonth = Number(part.value);
    if (part.type === "month") month = Number(part.value);
    if (part.type === "weekday") weekdayRaw = part.value.toLowerCase();
  }
  const dayOfWeekMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: dayOfWeekMap[weekdayRaw.slice(0, 3)] ?? 0,
  };
}

function computeNextCronRunAtMs(expr: string, nowMs: number, tz?: string): number | undefined {
  const matcher = parseCronExpr(expr);
  if (!matcher) {
    return undefined;
  }
  const timezone = resolveCronTimezone(tz);
  let cursor = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i += 1) {
    const parts = getZonedDateParts(cursor, timezone);
    if (matcher.matches(parts)) {
      return cursor;
    }
    cursor += MINUTE_MS;
  }
  return undefined;
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    if (atMs === null) {
      return undefined;
    }
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  return computeNextCronRunAtMs(expr, nowMs, schedule.tz);
}

export function validateCronExpression(expr: string): string | null {
  if (!expr.trim()) {
    return "Cron expression is required.";
  }
  const matcher = parseCronExpr(expr);
  if (!matcher) {
    return "Cron expression must contain 5 fields and only use numbers, '*', ranges, lists, or steps.";
  }
  return null;
}
