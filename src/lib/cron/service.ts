import { createChat, getChat } from "@/lib/storage/chat-store";
import { getAllProjects, getProject } from "@/lib/storage/project-store";
import { getTelegramIntegrationRuntimeConfig } from "@/lib/storage/telegram-integration-store";
import { runAgentText } from "@/lib/agent/agent";
import { parseAbsoluteTimeMs } from "@/lib/cron/parse";
import { resolveCronRunLogPath, resolveCronStorePath, GLOBAL_CRON_PROJECT_ID } from "@/lib/cron/paths";
import { appendCronRunLog, readCronRunLogEntries } from "@/lib/cron/run-log";
import { computeNextRunAtMs, validateCronExpression } from "@/lib/cron/schedule";
import { loadCronStore, saveCronStore, withCronStoreLock } from "@/lib/cron/store";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunLogEntry,
  CronRunStatus,
  CronSchedule,
  CronStoreFile,
} from "@/lib/cron/types";

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 60_000;
const MIN_REFIRE_GAP_MS = 2_000;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
const ERROR_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const TELEGRAM_TEXT_LIMIT = 4096;

type RunResult = {
  status: CronRunStatus;
  error?: string;
  summary?: string;
  startedAt: number;
  endedAt: number;
};

type ClaimedCronJob = {
  projectId: string;
  job: CronJob;
};

type ProjectStatus = {
  projectId: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

function normalizeProjectId(projectId: string): string {
  const trimmed = projectId.trim();
  return trimmed || GLOBAL_CRON_PROJECT_ID;
}

function throwIfInvalidProjectId(projectId: string): void {
  if (projectId === GLOBAL_CRON_PROJECT_ID) {
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(projectId)) {
    throw new Error("Invalid project id.");
  }
}

async function assertProjectExists(projectId: string): Promise<void> {
  if (projectId === GLOBAL_CRON_PROJECT_ID) {
    return;
  }
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Cron job name is required.");
  }
  return raw.trim();
}

function normalizeOptionalText(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function normalizeTelegramChatId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(Math.trunc(raw));
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function normalizeSchedule(raw: CronSchedule): CronSchedule {
  if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") {
    throw new Error("schedule is required.");
  }
  if (raw.kind === "at") {
    const at = typeof raw.at === "string" ? raw.at.trim() : "";
    if (!at) {
      throw new Error('schedule.at is required for schedule.kind="at".');
    }
    const atMs = parseAbsoluteTimeMs(at);
    if (atMs === null || !Number.isFinite(atMs)) {
      throw new Error("schedule.at must be a valid timestamp.");
    }
    return { kind: "at", at: new Date(atMs).toISOString() };
  }
  if (raw.kind === "every") {
    const everyMs = Math.floor(Number(raw.everyMs));
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error("schedule.everyMs must be a positive integer.");
    }
    const anchorMs =
      typeof raw.anchorMs === "number" && Number.isFinite(raw.anchorMs)
        ? Math.max(0, Math.floor(raw.anchorMs))
        : undefined;
    return { kind: "every", everyMs, anchorMs };
  }
  if (raw.kind === "cron") {
    const expr = typeof raw.expr === "string" ? raw.expr.trim() : "";
    if (!expr) {
      throw new Error("schedule.expr is required for cron schedule.");
    }
    const cronError = validateCronExpression(expr);
    if (cronError) {
      throw new Error(cronError);
    }
    const tz = typeof raw.tz === "string" && raw.tz.trim() ? raw.tz.trim() : undefined;
    return { kind: "cron", expr, tz };
  }
  throw new Error('schedule.kind must be one of "at", "every", or "cron".');
}

function normalizePayload(raw: CronJobCreate["payload"]): CronJob["payload"] {
  if (!raw || typeof raw !== "object" || raw.kind !== "agentTurn") {
    throw new Error('payload.kind must be "agentTurn".');
  }
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    throw new Error("payload.message is required.");
  }
  const chatId = normalizeOptionalText(raw.chatId);
  const telegramChatId = normalizeTelegramChatId(raw.telegramChatId);
  const currentPath = normalizeOptionalText(raw.currentPath);
  const timeoutSecondsRaw = raw.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw)
      ? Math.max(0, Math.floor(timeoutSecondsRaw))
      : undefined;
  return {
    kind: "agentTurn",
    message,
    chatId,
    telegramChatId,
    currentPath,
    timeoutSeconds,
  };
}

function computeAtRunMs(schedule: Extract<CronSchedule, { kind: "at" }>): number | undefined {
  const atMs = parseAbsoluteTimeMs(schedule.at);
  if (atMs === null || !Number.isFinite(atMs)) {
    return undefined;
  }
  return atMs;
}

function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) {
    return undefined;
  }

  if (job.schedule.kind === "at") {
    const atMs = computeAtRunMs(job.schedule);
    if (atMs === undefined) {
      return undefined;
    }
    if (
      typeof job.state.lastRunAtMs === "number" &&
      (job.state.lastStatus === "ok" || job.state.lastStatus === "error" || job.state.lastStatus === "skipped") &&
      job.state.lastRunAtMs >= atMs
    ) {
      return undefined;
    }
    return atMs;
  }

  if (job.schedule.kind === "every") {
    const anchorMs =
      typeof job.schedule.anchorMs === "number" && Number.isFinite(job.schedule.anchorMs)
        ? Math.max(0, Math.floor(job.schedule.anchorMs))
        : Math.max(0, Math.floor(job.createdAtMs));
    return computeNextRunAtMs({ ...job.schedule, anchorMs }, nowMs);
  }

  return computeNextRunAtMs(job.schedule, nowMs);
}

function isJobDue(job: CronJob, nowMs: number): boolean {
  if (!job.enabled) {
    return false;
  }
  if (typeof job.state.runningAtMs === "number") {
    return false;
  }
  return typeof job.state.nextRunAtMs === "number" && nowMs >= job.state.nextRunAtMs;
}

function getErrorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

function applyPatch(job: CronJob, patch: CronJobPatch, nowMs: number): void {
  if ("name" in patch && patch.name !== undefined) {
    job.name = normalizeName(patch.name);
  }
  if ("description" in patch) {
    job.description = normalizeOptionalText(patch.description);
  }
  if (typeof patch.enabled === "boolean") {
    job.enabled = patch.enabled;
    if (!job.enabled) {
      job.state.runningAtMs = undefined;
    }
  }
  if (typeof patch.deleteAfterRun === "boolean") {
    job.deleteAfterRun = patch.deleteAfterRun;
  }
  if (patch.schedule) {
    const schedule = normalizeSchedule(patch.schedule);
    if (schedule.kind === "every" && typeof schedule.anchorMs !== "number") {
      schedule.anchorMs = nowMs;
    }
    job.schedule = schedule;
  }
  if (patch.payload) {
    const payloadPatch = patch.payload;
    const message =
      typeof payloadPatch.message === "string" ? payloadPatch.message.trim() : job.payload.message;
    if (!message) {
      throw new Error("payload.message cannot be empty.");
    }
    job.payload = {
      kind: "agentTurn",
      message,
      chatId:
        "chatId" in payloadPatch
          ? normalizeOptionalText(payloadPatch.chatId)
          : job.payload.chatId,
      telegramChatId:
        "telegramChatId" in payloadPatch
          ? normalizeTelegramChatId(payloadPatch.telegramChatId)
          : normalizeTelegramChatId(job.payload.telegramChatId),
      currentPath:
        "currentPath" in payloadPatch
          ? normalizeOptionalText(payloadPatch.currentPath)
          : job.payload.currentPath,
      timeoutSeconds:
        "timeoutSeconds" in payloadPatch
          ? typeof payloadPatch.timeoutSeconds === "number" &&
            Number.isFinite(payloadPatch.timeoutSeconds)
            ? Math.max(0, Math.floor(payloadPatch.timeoutSeconds))
            : undefined
          : job.payload.timeoutSeconds,
    };
  }
  job.updatedAtMs = nowMs;
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
}

function sanitizeStore(store: CronStoreFile, projectId: string, nowMs: number): boolean {
  let changed = false;
  if (!Array.isArray(store.jobs)) {
    store.jobs = [];
    changed = true;
  }

  const normalizedJobs: CronJob[] = [];
  for (const raw of store.jobs) {
    if (!raw || typeof raw !== "object") {
      changed = true;
      continue;
    }
    const job = raw as CronJob;
    if (typeof job.id !== "string" || !job.id.trim()) {
      changed = true;
      continue;
    }
    if (
      !job.schedule ||
      typeof job.schedule !== "object" ||
      !("kind" in job.schedule) ||
      (job.schedule.kind !== "at" &&
        job.schedule.kind !== "every" &&
        job.schedule.kind !== "cron")
    ) {
      changed = true;
      continue;
    }
    if (
      !job.payload ||
      typeof job.payload !== "object" ||
      job.payload.kind !== "agentTurn" ||
      typeof job.payload.message !== "string"
    ) {
      changed = true;
      continue;
    }
    if (typeof job.name !== "string" || !job.name.trim()) {
      job.name = `Cron job ${job.id.slice(0, 8)}`;
      changed = true;
    }
    if (typeof job.createdAtMs !== "number" || !Number.isFinite(job.createdAtMs)) {
      job.createdAtMs = nowMs;
      changed = true;
    }
    if (typeof job.updatedAtMs !== "number" || !Number.isFinite(job.updatedAtMs)) {
      job.updatedAtMs = nowMs;
      changed = true;
    }
    const normalizedTelegramChatId = normalizeTelegramChatId(job.payload.telegramChatId);
    if (job.payload.telegramChatId !== normalizedTelegramChatId) {
      job.payload.telegramChatId = normalizedTelegramChatId;
      changed = true;
    }
    if (job.projectId !== projectId) {
      job.projectId = projectId;
      changed = true;
    }
    if (typeof job.enabled !== "boolean") {
      job.enabled = true;
      changed = true;
    }
    if (!job.state || typeof job.state !== "object") {
      job.state = {};
      changed = true;
    }
    if (typeof job.state.runningAtMs === "number" && nowMs - job.state.runningAtMs > STUCK_RUN_MS) {
      job.state.runningAtMs = undefined;
      changed = true;
    }
    if (job.schedule.kind === "every") {
      if (
        typeof job.schedule.anchorMs !== "number" ||
        !Number.isFinite(job.schedule.anchorMs)
      ) {
        job.schedule.anchorMs = Math.max(0, Math.floor(job.createdAtMs || nowMs));
        changed = true;
      }
    }
    if (!job.enabled) {
      if (job.state.nextRunAtMs !== undefined) {
        job.state.nextRunAtMs = undefined;
        changed = true;
      }
    } else if (typeof job.state.nextRunAtMs !== "number" || !Number.isFinite(job.state.nextRunAtMs)) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
      changed = true;
    }
    normalizedJobs.push(job);
  }
  if (normalizedJobs.length !== store.jobs.length) {
    changed = true;
  }
  store.jobs = normalizedJobs;
  return changed;
}

async function withProjectStore<T>(
  projectIdRaw: string,
  fn: (ctx: { store: CronStoreFile; nowMs: number; storePath: string; markChanged: () => void }) => Promise<T>
): Promise<T> {
  const projectId = normalizeProjectId(projectIdRaw);
  throwIfInvalidProjectId(projectId);
  const storePath = resolveCronStorePath(projectId);

  return await withCronStoreLock(storePath, async () => {
    const store = await loadCronStore(storePath);
    const nowMs = Date.now();
    let changed = sanitizeStore(store, projectId, nowMs);
    const value = await fn({
      store,
      nowMs,
      storePath,
      markChanged: () => {
        changed = true;
      },
    });
    if (changed) {
      await saveCronStore(storePath, store);
    }
    return value;
  });
}

async function claimDueJobsForProject(projectIdRaw: string, nowMs: number): Promise<ClaimedCronJob[]> {
  return await withProjectStore(projectIdRaw, async ({ store, markChanged }) => {
    const due: ClaimedCronJob[] = [];
    for (const job of store.jobs) {
      if (!job.enabled) {
        continue;
      }
      if (typeof job.state.nextRunAtMs !== "number") {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
        markChanged();
      }
      if (!isJobDue(job, nowMs)) {
        continue;
      }
      job.state.runningAtMs = nowMs;
      job.state.lastError = undefined;
      markChanged();
      due.push({
        projectId: job.projectId,
        job: structuredClone(job),
      });
    }
    return due;
  });
}

async function finalizeJobRun(projectIdRaw: string, jobId: string, result: RunResult): Promise<void> {
  const projectId = normalizeProjectId(projectIdRaw);
  let logEntry: CronRunLogEntry | null = null;

  await withProjectStore(projectId, async ({ store, markChanged }) => {
    const job = store.jobs.find((item) => item.id === jobId);
    if (!job) {
      return;
    }

    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = result.startedAt;
    job.state.lastStatus = result.status;
    job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
    job.state.lastError = result.error;
    job.updatedAtMs = result.endedAt;

    if (result.status === "error") {
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    } else {
      job.state.consecutiveErrors = 0;
    }

    const shouldDelete =
      job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";

    if (shouldDelete) {
      store.jobs = store.jobs.filter((item) => item.id !== job.id);
      markChanged();
      logEntry = {
        ts: Date.now(),
        projectId,
        jobId,
        status: result.status,
        error: result.error,
        summary: result.summary,
        runAtMs: result.startedAt,
        durationMs: job.state.lastDurationMs,
      };
      return;
    }

    if (job.schedule.kind === "at") {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      markChanged();
    } else if (result.status === "error" && job.enabled) {
      const backoffMs = getErrorBackoffMs(job.state.consecutiveErrors ?? 1);
      const naturalNext = computeJobNextRunAtMs(job, result.endedAt);
      const backoffNext = result.endedAt + backoffMs;
      job.state.nextRunAtMs =
        naturalNext !== undefined ? Math.max(naturalNext, backoffNext) : backoffNext;
      markChanged();
    } else if (job.enabled) {
      const naturalNext = computeJobNextRunAtMs(job, result.endedAt);
      if (job.schedule.kind === "cron") {
        const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
        job.state.nextRunAtMs =
          naturalNext !== undefined ? Math.max(naturalNext, minNext) : minNext;
      } else {
        job.state.nextRunAtMs = naturalNext;
      }
      markChanged();
    } else {
      job.state.nextRunAtMs = undefined;
      markChanged();
    }

    logEntry = {
      ts: Date.now(),
      projectId,
      jobId,
      status: result.status,
      error: result.error,
      summary: result.summary,
      runAtMs: result.startedAt,
      durationMs: job.state.lastDurationMs,
      nextRunAtMs: job.state.nextRunAtMs,
    };
  });

  if (logEntry) {
    const logPath = resolveCronRunLogPath(projectId, jobId);
    await appendCronRunLog(logPath, logEntry);
  }
}

async function executeCronJob(job: CronJob): Promise<RunResult> {
  const startedAt = Date.now();
  if (job.payload.kind !== "agentTurn") {
    return {
      status: "skipped",
      error: 'Only payload.kind="agentTurn" is supported.',
      startedAt,
      endedAt: Date.now(),
    };
  }

  const chatId = (job.payload.chatId?.trim() || `cron-${job.id}`);
  const projectId = job.projectId === GLOBAL_CRON_PROJECT_ID ? undefined : job.projectId;
  const existingChat = await getChat(chatId);
  if (!existingChat) {
    await createChat(chatId, `Cron: ${job.name}`, projectId);
  }

  const timeoutMs =
    typeof job.payload.timeoutSeconds === "number"
      ? job.payload.timeoutSeconds <= 0
        ? undefined
        : job.payload.timeoutSeconds * 1_000
      : DEFAULT_JOB_TIMEOUT_MS;

  const telegramChatId = normalizeTelegramChatId(job.payload.telegramChatId);
  let telegramBotToken = "";
  if (telegramChatId) {
    const telegramRuntime = await getTelegramIntegrationRuntimeConfig();
    telegramBotToken = telegramRuntime.botToken.trim();
    if (!telegramBotToken) {
      return {
        status: "error",
        error:
          "payload.telegramChatId is set, but Telegram bot token is not configured.",
        startedAt,
        endedAt: Date.now(),
      };
    }
  }

  const normalizeOutgoingTelegramText = (text: string): string => {
    const value = text.trim();
    if (!value) return "Пустой ответ от cron-задачи.";
    if (value.length <= TELEGRAM_TEXT_LIMIT) return value;
    return `${value.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
  };

  const formatTelegramCronResult = (result: RunResult): string => {
    if (result.status === "ok") {
      return `Cron "${job.name}" выполнен.\n\n${result.summary ?? "Без текста ответа."}`;
    }
    if (result.status === "skipped") {
      return `Cron "${job.name}" пропущен.\n\n${result.error ?? "Пустой ответ."}`;
    }
    return `Cron "${job.name}" завершился с ошибкой.\n\n${result.error ?? "Unknown error."}`;
  };

  const sendTelegramMessage = async (chatIdValue: string, text: string): Promise<void> => {
    const response = await fetch(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatIdValue,
          text: normalizeOutgoingTelegramText(text),
        }),
      }
    );

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(
        `Telegram sendMessage failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}`
      );
    }
  };

  const deliverToTelegram = async (result: RunResult): Promise<RunResult> => {
    if (!telegramChatId || !telegramBotToken) {
      return result;
    }
    try {
      await sendTelegramMessage(telegramChatId, formatTelegramCronResult(result));
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const deliveryError = `Telegram delivery failed: ${message}`;
      if (result.status === "error") {
        return {
          ...result,
          endedAt: Date.now(),
          error: result.error ? `${result.error} | ${deliveryError}` : deliveryError,
        };
      }
      return {
        ...result,
        status: "error",
        endedAt: Date.now(),
        error: deliveryError,
      };
    }
  };

  try {
    const runPromise = runAgentText({
      chatId,
      userMessage: job.payload.message,
      projectId,
      currentPath: job.payload.currentPath,
      runtimeData:
        telegramChatId && telegramBotToken
          ? {
              telegram: {
                botToken: telegramBotToken,
                chatId: telegramChatId,
              },
            }
          : undefined,
    });
    const output =
      typeof timeoutMs === "number"
        ? await Promise.race([
            runPromise,
            new Promise<string>((_, reject) => {
              setTimeout(() => reject(new Error("Cron job execution timed out.")), timeoutMs);
            }),
          ])
        : await runPromise;

    const summary = output.trim();
    return await deliverToTelegram({
      status: summary ? "ok" : "skipped",
      summary: summary || undefined,
      startedAt,
      endedAt: Date.now(),
    });
  } catch (error) {
    return await deliverToTelegram({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      endedAt: Date.now(),
    });
  }
}

async function executeClaimedJobs(claimed: ClaimedCronJob[]): Promise<void> {
  for (const item of claimed) {
    const result = await executeCronJob(item.job);
    await finalizeJobRun(item.projectId, item.job.id, result);
  }
}

export async function listKnownCronProjectIds(): Promise<string[]> {
  const projects = await getAllProjects();
  const ids = projects.map((project) => project.id).filter(Boolean);
  return [GLOBAL_CRON_PROJECT_ID, ...ids];
}

export async function listCronJobs(
  projectIdRaw: string,
  opts?: { includeDisabled?: boolean }
): Promise<CronJob[]> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  return await withProjectStore(projectId, async ({ store }) => {
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = store.jobs.filter((job) => includeDisabled || job.enabled);
    jobs.sort(
      (a, b) =>
        (a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER) -
        (b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER)
    );
    return jobs.map((job) => structuredClone(job));
  });
}

export async function getCronJob(
  projectIdRaw: string,
  jobId: string
): Promise<CronJob | null> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  return await withProjectStore(projectId, async ({ store }) => {
    const job = store.jobs.find((item) => item.id === jobId);
    return job ? structuredClone(job) : null;
  });
}

export async function getCronProjectStatus(projectIdRaw: string): Promise<ProjectStatus> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  return await withProjectStore(projectId, async ({ store }) => {
    let nextWakeAtMs: number | null = null;
    for (const job of store.jobs) {
      if (!job.enabled || typeof job.state.nextRunAtMs !== "number") {
        continue;
      }
      if (nextWakeAtMs === null || job.state.nextRunAtMs < nextWakeAtMs) {
        nextWakeAtMs = job.state.nextRunAtMs;
      }
    }
    return {
      projectId,
      jobs: store.jobs.length,
      nextWakeAtMs,
    };
  });
}

export async function addCronJob(
  projectIdRaw: string,
  input: CronJobCreate
): Promise<CronJob> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  return await withProjectStore(projectId, async ({ store, nowMs, markChanged }) => {
    const schedule = normalizeSchedule(input.schedule);
    const payload = normalizePayload(input.payload);
    const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
    const deleteAfterRun =
      typeof input.deleteAfterRun === "boolean"
        ? input.deleteAfterRun
        : schedule.kind === "at"
          ? true
          : undefined;
    const job: CronJob = {
      id: crypto.randomUUID(),
      projectId,
      name: normalizeName(input.name),
      description: normalizeOptionalText(input.description),
      enabled,
      deleteAfterRun,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule:
        schedule.kind === "every" && typeof schedule.anchorMs !== "number"
          ? { ...schedule, anchorMs: nowMs }
          : schedule,
      payload,
      state: {},
    };
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
    store.jobs.push(job);
    markChanged();
    return structuredClone(job);
  });
}

export async function updateCronJob(
  projectIdRaw: string,
  jobId: string,
  patch: CronJobPatch
): Promise<CronJob | null> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  return await withProjectStore(projectId, async ({ store, nowMs, markChanged }) => {
    const job = store.jobs.find((item) => item.id === jobId);
    if (!job) {
      return null;
    }
    applyPatch(job, patch, nowMs);
    markChanged();
    return structuredClone(job);
  });
}

export async function removeCronJob(
  projectIdRaw: string,
  jobId: string
): Promise<{ removed: boolean }> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  return await withProjectStore(projectId, async ({ store, markChanged }) => {
    const before = store.jobs.length;
    store.jobs = store.jobs.filter((item) => item.id !== jobId);
    const removed = store.jobs.length !== before;
    if (removed) {
      markChanged();
    }
    return { removed };
  });
}

export async function runCronJobNow(
  projectIdRaw: string,
  jobId: string
): Promise<{ ran: boolean; reason?: "not-found" | "already-running" }> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  const claimed = await withProjectStore(projectId, async ({ store, nowMs, markChanged }) => {
    const job = store.jobs.find((item) => item.id === jobId);
    if (!job) {
      return null;
    }
    if (typeof job.state.runningAtMs === "number") {
      return "already-running" as const;
    }
    job.state.runningAtMs = nowMs;
    job.state.lastError = undefined;
    markChanged();
    return structuredClone(job);
  });

  if (claimed === null) {
    return { ran: false, reason: "not-found" };
  }
  if (claimed === "already-running") {
    return { ran: false, reason: "already-running" };
  }

  const result = await executeCronJob(claimed);
  await finalizeJobRun(projectId, claimed.id, result);
  return { ran: true };
}

export async function listCronRuns(
  projectIdRaw: string,
  jobId: string,
  limit?: number
): Promise<CronRunLogEntry[]> {
  const projectId = normalizeProjectId(projectIdRaw);
  await assertProjectExists(projectId);
  const logPath = resolveCronRunLogPath(projectId, jobId);
  return await readCronRunLogEntries(logPath, { limit });
}

async function computeNextGlobalWakeAtMs(projectIds: string[]): Promise<number | null> {
  let min: number | null = null;
  for (const projectId of projectIds) {
    const status = await getCronProjectStatus(projectId).catch(() => null);
    if (!status || status.nextWakeAtMs === null) {
      continue;
    }
    if (min === null || status.nextWakeAtMs < min) {
      min = status.nextWakeAtMs;
    }
  }
  return min;
}

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.arm(200);
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(delayMs: number) {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, Math.max(50, delayMs));
  }

  private async tick() {
    if (!this.started) {
      return;
    }
    if (this.running) {
      this.arm(MAX_TIMER_DELAY_MS);
      return;
    }

    this.running = true;
    try {
      const nowMs = Date.now();
      const projectIds = await listKnownCronProjectIds();
      const claimed: ClaimedCronJob[] = [];
      for (const projectId of projectIds) {
        const due = await claimDueJobsForProject(projectId, nowMs).catch(() => []);
        claimed.push(...due);
      }
      if (claimed.length > 0) {
        await executeClaimedJobs(claimed);
      }
      const nextWakeAtMs = await computeNextGlobalWakeAtMs(projectIds);
      const delay = nextWakeAtMs === null ? MAX_TIMER_DELAY_MS : Math.max(nextWakeAtMs - Date.now(), 0);
      this.arm(Math.min(delay, MAX_TIMER_DELAY_MS));
    } catch {
      this.arm(MAX_TIMER_DELAY_MS);
    } finally {
      this.running = false;
    }
  }
}
