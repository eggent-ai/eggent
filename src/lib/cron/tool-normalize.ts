import type { CronJobCreate, CronJobPatch, CronSchedule } from "@/lib/cron/types";

type UnknownRecord = Record<string, unknown>;

const CRON_JOB_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "enabled",
  "deleteAfterRun",
  "data",
  "schedule",
  "scheduleKind",
  "scheduleAt",
  "at",
  "everyMs",
  "anchorMs",
  "expr",
  "cronExpr",
  "cronTz",
  "tz",
  "delaySeconds",
  "delayMs",
  "payload",
  "message",
  "payloadMessage",
  "text",
  "chatId",
  "telegramChatId",
  "telegram_chat_id",
  "currentPath",
  "timeoutSeconds",
  "job",
]);

const CRON_PATCH_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "enabled",
  "deleteAfterRun",
  "data",
  "schedule",
  "payload",
  "message",
  "text",
  "chatId",
  "telegramChatId",
  "telegram_chat_id",
  "currentPath",
  "timeoutSeconds",
  "patch",
]);

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function toRecord(value: unknown): UnknownRecord | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return undefined;
}

function copyKnownFields(input: UnknownRecord, keys: ReadonlySet<string>): UnknownRecord {
  const out: UnknownRecord = {};
  for (const key of Object.keys(input)) {
    if (keys.has(key) && input[key] !== undefined) {
      out[key] = input[key];
    }
  }
  return out;
}

function unwrapKnownWrappers(
  input: UnknownRecord,
  wrapperKeys: readonly string[]
): UnknownRecord {
  let current = input;
  for (let i = 0; i < 4; i++) {
    let next: UnknownRecord | null = null;
    for (const key of wrapperKeys) {
      const candidate = toRecord(current[key]);
      if (candidate && Object.keys(candidate).length > 0) {
        next = candidate;
        break;
      }
    }
    if (!next) {
      break;
    }
    current = next;
  }
  return current;
}

function hasMeaningfulAddFields(input: UnknownRecord): boolean {
  return Boolean(
    input.schedule !== undefined ||
      input.payload !== undefined ||
      input.message !== undefined ||
      input.text !== undefined ||
      input.delaySeconds !== undefined ||
      input.delayMs !== undefined ||
      input.scheduleKind !== undefined ||
      input.at !== undefined ||
      input.everyMs !== undefined ||
      input.expr !== undefined ||
      input.cronExpr !== undefined
  );
}

function extractAddSource(input: UnknownRecord): UnknownRecord {
  const rawData = toRecord(input.data);
  if (rawData && Object.keys(rawData).length > 0) {
    return unwrapKnownWrappers(rawData, ["data", "job"]);
  }

  const rawJob = toRecord(input.job);
  if (rawJob && Object.keys(rawJob).length > 0) {
    return unwrapKnownWrappers(rawJob, ["data", "job"]);
  }

  const synthetic = copyKnownFields(input, CRON_JOB_KEYS);
  if (hasMeaningfulAddFields(synthetic)) {
    return unwrapKnownWrappers(synthetic, ["data", "job"]);
  }

  return unwrapKnownWrappers(input, ["data", "job"]);
}

function extractPatchSource(input: UnknownRecord, patch: unknown): UnknownRecord | null {
  const patchRecord = toRecord(patch);
  if (patchRecord && Object.keys(patchRecord).length > 0) {
    return unwrapKnownWrappers(patchRecord, ["data", "patch", "job"]);
  }
  const synthetic = copyKnownFields(input, CRON_PATCH_KEYS);
  return Object.keys(synthetic).length > 0
    ? unwrapKnownWrappers(synthetic, ["data", "patch", "job"])
    : null;
}

function normalizeScheduleFromRecord(input: UnknownRecord): CronSchedule | null {
  const scheduleRecord = toRecord(input.schedule);
  const scheduleRaw = scheduleRecord
    ? unwrapKnownWrappers(scheduleRecord, ["data", "schedule"])
    : input;

  const rawKind = readString(scheduleRaw.kind)?.toLowerCase();
  const at =
    readString(scheduleRaw.at) ??
    readString(scheduleRaw.scheduleAt) ??
    readString(scheduleRaw.runAt) ??
    readString(scheduleRaw.when);
  const everyMs = readNumber(scheduleRaw.everyMs);
  const anchorMs = readNumber(scheduleRaw.anchorMs);
  const expr = readString(scheduleRaw.expr) ?? readString(scheduleRaw.cronExpr);
  const tz = readString(scheduleRaw.tz) ?? readString(scheduleRaw.cronTz);

  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at
        ? "at"
        : everyMs
          ? "every"
          : expr
            ? "cron"
            : readString(scheduleRaw.scheduleKind)?.toLowerCase();

  if (kind === "at" && at) {
    return { kind: "at", at };
  }
  if (kind === "every" && everyMs && everyMs > 0) {
    return {
      kind: "every",
      everyMs: Math.max(1, Math.floor(everyMs)),
      anchorMs:
        typeof anchorMs === "number" && Number.isFinite(anchorMs)
          ? Math.max(0, Math.floor(anchorMs))
          : undefined,
    };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz };
  }

  const delaySeconds =
    readNumber(scheduleRaw.delaySeconds) ??
    readNumber(scheduleRaw.inSeconds) ??
    readNumber(scheduleRaw.afterSeconds) ??
    readNumber(scheduleRaw.seconds);
  const delayMs =
    readNumber(scheduleRaw.delayMs) ??
    readNumber(scheduleRaw.inMs) ??
    readNumber(scheduleRaw.afterMs);

  const totalMs =
    typeof delayMs === "number" && delayMs > 0
      ? delayMs
      : typeof delaySeconds === "number" && delaySeconds > 0
        ? delaySeconds * 1_000
        : 0;
  if (totalMs > 0) {
    return { kind: "at", at: new Date(Date.now() + totalMs).toISOString() };
  }

  return null;
}

function normalizePayloadFromRecord(input: UnknownRecord): CronJobCreate["payload"] | null {
  const payloadRaw = toRecord(input.payload);
  const payload = payloadRaw ? unwrapKnownWrappers(payloadRaw, ["data", "payload"]) : input;

  const rawKind = readString(payload.kind)?.toLowerCase();
  const kind = rawKind === "agentturn" ? "agentTurn" : rawKind;
  const message =
    readString(payload.message) ??
    readString(payload.text) ??
    readString(input.message) ??
    readString(input.payloadMessage) ??
    readString(input.text);

  if ((kind && kind !== "agentturn" && kind !== "agentTurn") || !message) {
    return null;
  }

  const timeoutSeconds = readNumber(payload.timeoutSeconds) ?? readNumber(input.timeoutSeconds);
  return {
    kind: "agentTurn",
    message,
    chatId: readString(payload.chatId) ?? readString(input.chatId),
    telegramChatId:
      readString(payload.telegramChatId) ??
      readString(payload.telegram_chat_id) ??
      readString(input.telegramChatId) ??
      readString(input.telegram_chat_id),
    currentPath: readString(payload.currentPath) ?? readString(input.currentPath),
    timeoutSeconds:
      typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
        ? Math.max(0, Math.floor(timeoutSeconds))
        : undefined,
  };
}

function explainAddInputFailure(source: UnknownRecord): string {
  const schedule = normalizeScheduleFromRecord(source);
  const payload = normalizePayloadFromRecord(source);

  if (schedule && payload) {
    return "";
  }

  const problems: string[] = [];
  if (!schedule) {
    problems.push(
      "Missing schedule. Provide `schedule` (`at`/`every`/`cron`) or `delaySeconds`/`delayMs`."
    );
  }

  if (!payload) {
    const payloadRecord = toRecord(source.payload);
    const hasMessage =
      Boolean(readString(payloadRecord?.message)) ||
      Boolean(readString(payloadRecord?.text)) ||
      Boolean(readString(source.message)) ||
      Boolean(readString(source.payloadMessage)) ||
      Boolean(readString(source.text));
    const rawKind = readString(payloadRecord?.kind);

    if (!hasMessage) {
      problems.push("Missing payload message. Provide `payload.message` (or top-level `message`).");
    } else if (rawKind && rawKind.toLowerCase() !== "agentturn") {
      problems.push("Invalid payload kind. `payload.kind` must be `agentTurn`.");
    } else {
      problems.push("Invalid payload object. Expected `payload.kind=\"agentTurn\"` + `payload.message`.");
    }
  }

  problems.push(
    "Example: {\"action\":\"add\",\"delaySeconds\":30,\"message\":\"Отправь пользователю: привет\"}"
  );
  return problems.join(" ");
}

export function normalizeCronToolAddInput(rawInput: unknown): CronJobCreate | null {
  const input = toRecord(rawInput);
  if (!input) return null;

  const source = extractAddSource(input);
  const schedule = normalizeScheduleFromRecord(source);
  const payload = normalizePayloadFromRecord(source);
  if (schedule && payload) {
    const enabled = readBoolean(source.enabled);
    const deleteAfterRun = readBoolean(source.deleteAfterRun);
    return {
      name: readString(source.name) ?? "Cron job",
      description: readString(source.description),
      enabled: enabled ?? true,
      deleteAfterRun: deleteAfterRun ?? (schedule.kind === "at" ? true : undefined),
      schedule,
      payload,
    };
  }

  return null;
}

export function explainCronToolAddInputFailure(rawInput: unknown): string {
  const input = toRecord(rawInput);
  if (!input) {
    return "Arguments must be a JSON object.";
  }
  const source = extractAddSource(input);
  return explainAddInputFailure(source);
}

export function normalizeCronToolPatchInput(
  rawInput: unknown,
  rawPatch: unknown
): CronJobPatch | null {
  const input = toRecord(rawInput);
  if (!input) return null;
  const source = extractPatchSource(input, rawPatch);
  if (!source) return null;

  const patch: CronJobPatch = {};
  if ("name" in source) {
    patch.name = readString(source.name) ?? "";
  }
  if ("description" in source) {
    patch.description = readString(source.description) ?? "";
  }
  if ("enabled" in source) {
    const enabled = readBoolean(source.enabled);
    if (typeof enabled === "boolean") patch.enabled = enabled;
  }
  if ("deleteAfterRun" in source) {
    const deleteAfterRun = readBoolean(source.deleteAfterRun);
    if (typeof deleteAfterRun === "boolean") patch.deleteAfterRun = deleteAfterRun;
  }

  if ("schedule" in source || "scheduleKind" in source || "at" in source || "everyMs" in source || "expr" in source || "cronExpr" in source) {
    const schedule = normalizeScheduleFromRecord(source);
    if (!schedule) return null;
    patch.schedule = schedule;
  }

  const payload = normalizePayloadFromRecord(source);
  if (payload) {
    patch.payload = {
      kind: "agentTurn",
      message: payload.message,
      chatId: payload.chatId,
      telegramChatId: payload.telegramChatId,
      currentPath: payload.currentPath,
      timeoutSeconds: payload.timeoutSeconds,
    };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
