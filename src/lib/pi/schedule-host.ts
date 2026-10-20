import fs from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { GATEWAY_REFUSAL_ID_PREFIX } from "@/lib/pi/gateway-refusal";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { getAllProjects, getWorkDir } from "@/lib/storage/project-store";
import type { Chat, ChatMessage } from "@/lib/types";
import { afterTelegramDelivery, deliverChatToTelegram } from "@/lib/telegram/conversation";
import { takeHelperDeliveries, type HelperDelivery } from "@/lib/pi/helper-deliveries";
import { getActiveRun } from "@/lib/pi/active-runs";
import { detectSchedule, raiseScheduledTurns, withScheduleExecutionDirective } from "@/lib/pi/schedule-policy";
import { piScheduleStorePath } from "@/lib/pi/session-lifecycle";
import { subagentMonitorFor } from "@/lib/pi/subagents";
import { describeProviderFailure, redactSecrets } from "@/lib/pi/provider-failure";
import { forgetJobHealth, healthKey, recordRunOutcome, type RunDelivery, type RunOutcome } from "@/lib/pi/schedule-health";
import {
  isScheduledRunSessionId,
  markScheduledRunSession,
  SCHEDULED_RUN_REFUSAL,
  unmarkScheduledRunSession,
} from "@/lib/pi/scheduled-run-state";

type ScheduleJobRecord = {
  id?: string;
  name?: string;
  description?: string;
  schedule?: string;
  scheduleType?: "cron" | "once" | "interval" | string;
  intervalMs?: number;
  subagent_type?: string;
  prompt?: string;
  model?: string;
  thinking?: string;
  max_turns?: number;
  isolated?: boolean;
  isolation?: string;
  enabled?: boolean;
  createdAt?: string;
  nextRun?: string;
  lastRun?: string;
  lastStatus?: string;
  runCount?: number;
  /** Who switched it off: "eggent" after runs that could not be carried out, "user" when asked to. */
  pausedBy?: "eggent" | "user";
  pausedReason?: "refused" | "failed";
  pausedAt?: string;
  /** What the last run said was wrong, as the person was told. */
  pausedDetail?: string;
};

type ScheduleStoreFile = {
  version?: number;
  jobs?: ScheduleJobRecord[];
};

type ToolRecord = {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  status: "running" | "completed" | "error";
};

type RetainedReason = "schedule" | "mcp-oauth";

type RetainedSession = {
  chatId: string;
  projectId?: string | null;
  session: AgentSession;
  reason: RetainedReason;
  unsubscribe: () => void;
  interval: NodeJS.Timeout;
  emptySince?: number;
  expiresAt?: number;
  reloading?: boolean;
};

/**
 * The registries below live on the global object, not in this module.
 *
 * Next compiles the instrumentation hook and each route separately, and a
 * module-level Map in one is not the Map another of them sees - the same
 * reason the active runs and the event bus hang off the global. The sessions
 * armed at boot are registered here by the instrumentation hook, and the
 * schedule tool, the Schedules page and the chat runner read them from route
 * code; with one copy each, a retime or a delete could not find the session
 * that held the timers.
 */
type ScheduleHostState = {
  /** Sessions kept alive because they own an enabled schedule or an MCP sign-in. */
  retained: Map<string, RetainedSession>;
  /**
   * Retained sessions lent to a turn of their own chat. Their schedules stay
   * armed while they are out, so a change to the store has to find them too.
   */
  lent: Map<string, AgentSession>;
  /** Sessions whose scheduler must re-read its store once they are idle. */
  pendingScheduleReloads: WeakSet<AgentSession>;
  /** Runs in progress, by the session that owns the schedule. */
  scheduledRuns: WeakMap<AgentSession, ScheduledRun>;
};

const HOST_STATE_KEY = "__EGGENT_SCHEDULE_HOST__";

function scheduleHostState(): ScheduleHostState {
  const holder = globalThis as typeof globalThis & { [HOST_STATE_KEY]?: ScheduleHostState };
  if (!holder[HOST_STATE_KEY]) {
    holder[HOST_STATE_KEY] = {
      retained: new Map<string, RetainedSession>(),
      lent: new Map<string, AgentSession>(),
      pendingScheduleReloads: new WeakSet<AgentSession>(),
      scheduledRuns: new WeakMap<AgentSession, ScheduledRun>(),
    };
  }
  return holder[HOST_STATE_KEY];
}

const { retained, lent, pendingScheduleReloads, scheduledRuns } = scheduleHostState();
const POLL_MS = 5_000;
const EMPTY_GRACE_MS = 10 * 60_000;
const SCHEDULE_LOCK_RETRY_MS = 50;
const SCHEDULE_LOCK_MAX_RETRIES = 100;

function keyFor(chatId: string) {
  return chatId;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireScheduleLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < SCHEDULE_LOCK_MAX_RETRIES; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf-8");
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "EEXIST") throw error;

      try {
        const pid = Number.parseInt(await fs.readFile(lockPath, "utf-8"), 10);
        if (pid > 0 && !isProcessRunning(pid)) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }

      await wait(SCHEDULE_LOCK_RETRY_MS);
    }
  }

  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

async function writeScheduleStoreAtomic(filePath: string, data: ScheduleStoreFile) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tempPath, filePath);
}

async function mutateScheduleStore<T>(
  filePath: string,
  mutate: (data: ScheduleStoreFile) => { changed: boolean; result: T }
): Promise<T> {
  const release = await acquireScheduleLock(`${filePath}.lock`);
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf-8")) as ScheduleStoreFile;
    const outcome = mutate(data);
    if (outcome.changed) {
      await writeScheduleStoreAtomic(filePath, data);
    }
    return outcome.result;
  } finally {
    await release();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getToolArgs(event: Record<string, unknown>) {
  return event.args ?? event.input ?? {};
}

function getToolResult(event: Record<string, unknown>) {
  return event.result ?? event.output ?? event.partialResult ?? "";
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return asRecord(input) ?? {};
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const content = record?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const part = asRecord(item);
        return typeof part?.text === "string" ? part.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const scheduleStorePath = piScheduleStorePath;

function scheduleStoreDir(cwd: string): string {
  return path.join(cwd, ".pi", "subagent-schedules");
}

export async function normalizePiScheduleStore(session: AgentSession): Promise<boolean> {
  const filePath = scheduleStorePath(session);
  try {
    await fs.access(filePath);
  } catch {
    return false;
  }

  return mutateScheduleStore(filePath, (data) => {
    let changed = false;
    for (const job of data.jobs ?? []) {
      // A task made with too few turns to finish gets the floor new ones get.
      const turns = job.max_turns;
      raiseScheduledTurns(job as Record<string, unknown>);
      if (job.max_turns !== turns) changed = true;
      if (!job.prompt) continue;
      const normalized = withScheduleExecutionDirective(job.prompt);
      if (normalized === job.prompt) continue;
      job.prompt = normalized;
      changed = true;
    }
    return { changed, result: changed };
  });
}

async function hasEnabledSchedules(session: AgentSession): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(scheduleStorePath(session), "utf-8")) as ScheduleStoreFile;
    return (parsed.jobs ?? []).some((job) => job.enabled !== false);
  } catch {
    return false;
  }
}

/**
 * Whether this session still has a detached helper at work - a scheduled job
 * that fired, typically. Read from the session's own lifecycle events: the
 * extension's global registry belongs to whichever session in the process
 * activated it first, so it answered for a stranger.
 */
function hasRunningSubagents(session: AgentSession): boolean {
  return subagentMonitorFor(session)?.hasRunning() ?? false;
}

/**
 * A scheduled run in progress, from the moment its turn starts.
 *
 * Every run used to report into the chat the task was set up in, so a month of
 * mornings sat in one conversation and the report arrived in Telegram from a
 * chat the person was no longer in: their answer to it went somewhere else.
 * Each run now has a chat of its own - one per task and day - that holds what
 * the run did, and answering the report continues there.
 */
interface ScheduledRun {
  ownerChatId: string;
  projectId?: string | null;
  /**
   * Where the session stood before the run, so only the run is copied out;
   * null for a session that was empty, undefined when the start was missed.
   */
  startLeafId: string | null | undefined;
  /** What the finished job was called in its notification. */
  description?: string;
  /** Made on first need: by a tool sending to Telegram, or at the end. */
  chat?: Promise<Chat>;
  /** The agent already wrote to the person's own Telegram chat itself. */
  reachedTelegram: boolean;
  /** What the task's helper sent to the person's own chat before this turn began. */
  helperDeliveries?: HelperDelivery[];
  /** The model service turned the report's own request away: a limit the deployment enforces. */
  refused?: boolean;
  /** What it said, in the person's language. */
  refusalText?: string;
  /** The report's own model call ended in an error the runtime could not get past. */
  failure?: string;
  /** How the helper that did the work ended, from its notification. */
  childStatus?: string;
  childError?: string;
  /** The task this run was, found once: the run chat and the verdict both need it. */
  job?: Promise<{ id?: string; name: string } | null>;
}


/** Runs of one task on one day share a chat: a task firing every half hour must not make a chat each time. */
function runChatId(ownerChatId: string, jobKey: string, day: string): string {
  const hash = createHash("sha256").update(`${ownerChatId}|${jobKey}|${day}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Which job this run was. The scheduler stamps `lastRun` when a job's helper
 * finishes, which is just before its notification starts this turn; the
 * description the notification carries settles a tie.
 */
async function firedJob(session: AgentSession, description?: string): Promise<{ id?: string; name: string } | null> {
  let jobs: ScheduleJobRecord[] = [];
  try {
    jobs = (JSON.parse(await fs.readFile(scheduleStorePath(session), "utf-8")) as ScheduleStoreFile).jobs ?? [];
  } catch {
    jobs = [];
  }
  const recent = jobs
    .filter((job) => job.lastRun && Date.now() - Date.parse(job.lastRun) < 6 * 60 * 60_000)
    .sort((a, b) => Date.parse(b.lastRun!) - Date.parse(a.lastRun!));
  const job = (description ? recent.find((candidate) => candidate.description === description) : undefined) ?? recent[0];
  const name = job?.name?.trim() || job?.description?.trim() || description?.trim();
  return name ? { id: job?.id, name } : null;
}

function jobOf(session: AgentSession, run: ScheduledRun) {
  run.job ??= firedJob(session, run.description);
  return run.job;
}

/** Loaded on use: the translator reaches into Next, which this module otherwise does not need. */
async function translator() {
  return (await import("@/i18n/server")).getServerTranslator();
}

async function runChatTitle(jobName: string, day: string): Promise<string> {
  const t = await translator();
  const [, month, date] = day.split("-").map((part) => Number(part));
  const months = t("date.monthsShort").split(",");
  return t("schedules.runChatTitle", {
    job: jobName.length > 60 ? `${jobName.slice(0, 59)}…` : jobName,
    month: months[month - 1] ?? String(month),
    day: date,
  });
}

function ensureRunChat(session: AgentSession, run: ScheduledRun): Promise<Chat> {
  run.chat ??= (async () => {
    const owner = await getChat(run.ownerChatId);
    const t = await translator();
    const job = await jobOf(session, run);
    const jobName = job?.name || t("schedules.runFallbackName");
    const day = new Date().toISOString().slice(0, 10);
    const id = runChatId(run.ownerChatId, job?.id || jobName, day);
    const existing = await getChat(id);
    if (existing) return existing;

    const now = new Date().toISOString();
    const projectId = owner ? owner.projectId : run.projectId ?? undefined;
    const chat: Chat = {
      id,
      title: await runChatTitle(jobName, day),
      ...(projectId ? { projectId } : {}),
      scheduledRun: { ...(job?.id ? { jobId: job.id } : {}), jobName, ownerChatId: run.ownerChatId, day },
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await saveChat(chat);
    return chat;
  })();
  return run.chat;
}

/**
 * The chat the scheduled run now going on in this session reports into, or
 * null when nothing scheduled is running there. Tools that reach Telegram use
 * it, so a reply to what they sent continues the run, not the setup chat.
 */
export async function scheduledRunChatFor(session: AgentSession | null | undefined): Promise<Chat | null> {
  const run = session ? scheduledRuns.get(session) : undefined;
  return run ? ensureRunChat(session!, run) : null;
}

/** True while this session is writing the report of a scheduled run, with nobody in the turn. */
export function isScheduledRunSession(session: AgentSession | null | undefined): boolean {
  return isScheduledRunSessionId(session?.sessionId);
}

/** The run already wrote to the person, so its last words need not go out again. */
export function noteScheduledRunReachedTelegram(session: AgentSession | null | undefined): void {
  const run = session ? scheduledRuns.get(session) : undefined;
  if (run) run.reachedTelegram = true;
}

/**
 * Give the run's chat its own context: what the run did, and nothing before it.
 *
 * The screen shows a chat from the stored copy, but the agent answering in it
 * reads the runtime's record, and a new chat starts that record empty. Without
 * this, a reply to the report would reach an agent that had never seen it.
 */
async function copyRunIntoChatContext(session: AgentSession, run: ScheduledRun, chatId: string): Promise<void> {
  // Two writers on one record would tangle it; the next run's copy adds what this one skipped.
  if (run.startLeafId === undefined || getActiveRun(chatId)) return;
  const branch = session.sessionManager.getBranch();
  const startIndex = run.startLeafId === null
    ? 0
    : branch.findIndex((entry) => entry.id === run.startLeafId) + 1;
  // The start fell out of the branch, so the run's edges are unknown: copy
  // nothing rather than the whole history.
  if (run.startLeafId !== null && startIndex === 0) return;
  const entries = branch.slice(startIndex);
  if (!entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")) return;

  const { openChatSessionManager } = await import("@/lib/pi/session-files");
  const target = openChatSessionManager(chatId, session.sessionManager.getCwd());
  for (const entry of entries) {
    if (entry.type === "message") {
      target.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
    } else if (entry.type === "custom_message") {
      target.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    }
  }
}

/** What happened to the run, as far as the record is concerned. */
function classifyRun(run: ScheduledRun): { outcome: RunOutcome; detail?: string } {
  if (run.refused) return { outcome: "refused", detail: run.refusalText };
  if (run.failure) return { outcome: "failed", detail: run.failure };
  // "stopped" is somebody stopping the helper, not the task failing.
  if (run.childStatus === "error" || run.childStatus === "aborted") {
    return { outcome: "failed", detail: run.childError };
  }
  return { outcome: "ok" };
}

interface RunReview {
  delivery: RunDelivery;
  /** Written by the host instead of the run's own report. */
  notice?: string;
}

/**
 * Count the run, and decide what the person hears about it.
 *
 * A task that meets the same wall every time it fires used to deliver the
 * refusal as the day's report forever. The first refusal is still delivered, as
 * the report it is; the ones after it are kept in the run's chat and not sent;
 * and when it is clear the next one will fail the same way the task is paused
 * and the person is told so, once.
 */
async function reviewFinishedRun(session: AgentSession, run: ScheduledRun, hasReport: boolean): Promise<RunReview> {
  const { outcome, detail } = classifyRun(run);
  const job = await jobOf(session, run).catch(() => null);
  // Without the task's id there is nothing to count against.
  if (!job?.id) return { delivery: "report" };

  const verdict = await recordRunOutcome(healthKey(session.sessionId, job.id), outcome, {
    detail: detail ? redactSecrets(detail) : undefined,
    hasReport,
  });
  if (verdict.delivery === "report" || verdict.delivery === "silent") return { delivery: verdict.delivery };

  const t = await translator();
  const shown = verdict.health.detail;
  if (verdict.delivery === "notice") {
    return { delivery: "notice", notice: [t("schedules.run.failed", { job: job.name }), shown].filter(Boolean).join("\n\n") };
  }

  const reason = outcome === "refused" ? "refused" : "failed";
  // Not claimed unless it happened: a task that could not be switched off goes on reporting as before.
  if (!(await pauseJob(session, job.id, reason, shown))) return { delivery: "report" };
  return {
    delivery: "pause-notice",
    notice: [
      t(reason === "refused" ? "schedules.paused.refused" : "schedules.paused.failed", { job: job.name, count: verdict.health.streak }),
      shown,
      t("schedules.paused.resume"),
    ].filter(Boolean).join("\n\n"),
  };
}

/**
 * Put a message the host wrote into the run chat's own context. Without it a
 * reply to the notice - "resume it" - reaches an agent that has never seen it.
 */
async function noteInRunContext(session: AgentSession, chatId: string, text: string): Promise<void> {
  if (getActiveRun(chatId)) return;
  const { openChatSessionManager } = await import("@/lib/pi/session-files");
  openChatSessionManager(chatId, session.sessionManager.getCwd()).appendCustomMessageEntry("eggent-schedule-notice", text, true, undefined);
}

async function routeHelperDeliveries(run: ScheduledRun, chatId: string): Promise<void> {
  for (const delivery of run.helperDeliveries ?? []) {
    await afterTelegramDelivery({ destination: delivery.destination, result: delivery.result, chatId }).catch((error) => {
      console.warn("Could not remember what the scheduled task's helper sent:", error);
    });
  }
}

async function finishScheduledRun(
  session: AgentSession,
  run: ScheduledRun,
  assistantText: string,
  tools: ToolRecord[]
) {
  const completedTools = tools.filter((tool) => tool.status !== "running");
  const hasReport = Boolean(assistantText.trim()) || completedTools.length > 0;
  const review = await reviewFinishedRun(session, run, hasReport).catch((error): RunReview => {
    console.warn("Could not review the scheduled run:", error);
    return { delivery: "report" };
  });
  if (!hasReport && !review.notice) {
    // No report to put them under: a reply to them continues the owner chat.
    await routeHelperDeliveries(run, run.ownerChatId);
    return;
  }

  const text = review.notice ?? assistantText;
  const reported = review.notice ? [] : completedTools;

  const runChat = await ensureRunChat(session, run);
  const chat = (await getChat(runChat.id)) ?? runChat;
  // What the helper sent is answered in the run's chat, like the report itself.
  await routeHelperDeliveries(run, runChat.id);

  const now = new Date().toISOString();
  const assistantMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: text,
    createdAt: now,
    toolCalls: reported.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      args: normalizeToolInput(tool.input),
    })),
  };
  chat.messages.push(assistantMessage);

  for (const tool of reported) {
    chat.messages.push({
      id: crypto.randomUUID(),
      role: "tool",
      content: stringifyForDisplay(tool.output),
      createdAt: now,
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      toolResult: tool.output,
    });
  }

  chat.updatedAt = now;
  await saveChat(chat);

  await copyRunIntoChatContext(session, run, chat.id).catch((error) => {
    console.warn("Could not give the scheduled run's chat its context:", error);
  });
  if (review.notice) {
    await noteInRunContext(session, chat.id, review.notice).catch((error) => {
      console.warn("Could not give the scheduled run's chat its notice:", error);
    });
  }

  // The same thing happening again is kept in the run's chat and not sent: the
  // person has been told, and sending it every time is what a task meeting a
  // wall used to do.
  if (review.delivery === "silent") return;

  // The delivery deliberately does not depend on the agent calling a tool. A
  // scheduled job runs as a subagent with its own tool list, which is why every
  // "write to me at 07:00" ever asked for here produced the same answer: the
  // task fired, and then reported that it had nothing to send with. The host
  // knows both the result and the destination, so it does the sending itself -
  // unless the agent already wrote to the person, when its closing remark
  // ("the reminder is sent") would only arrive as a second, emptier message.
  // A notice is the host's own word and goes out either way.
  if (run.reachedTelegram && !review.notice) return;
  try {
    const result = await deliverChatToTelegram({ chatId: chat.id, text, title: chat.title });
    if (result && !result.success) {
      console.warn("Scheduled Telegram delivery failed:", result.error);
    }
  } catch (error) {
    console.warn("Scheduled Telegram delivery failed:", error);
  }
}

/**
 * Switch a task off after runs that could not be carried out.
 *
 * Written to the store and then handed to the re-arm the delete path uses: the
 * scheduler keeps its own copy of the jobs and goes on firing a task the file
 * says is off until the session holding it re-reads the store, and a reload
 * stops every helper that session has running.
 */
async function pauseJob(
  session: AgentSession,
  jobId: string,
  reason: "refused" | "failed",
  detail?: string
): Promise<boolean> {
  const outcome = await mutateScheduleStore(scheduleStorePath(session), (data) => {
    const job = (data.jobs ?? []).find((candidate) => candidate.id === jobId);
    if (!job || job.enabled === false) return { changed: false, result: null };
    job.enabled = false;
    job.pausedBy = "eggent";
    job.pausedReason = reason;
    job.pausedAt = new Date().toISOString();
    if (detail) job.pausedDetail = detail;
    else delete job.pausedDetail;
    return { changed: true, result: { remaining: (data.jobs ?? []).filter((candidate) => candidate.enabled !== false).length } };
  }).catch((error) => {
    console.warn(`[Schedules] Could not pause ${jobId}:`, error instanceof Error ? error.message : error);
    return null;
  });
  if (!outcome) return false;
  await rearmAfterClear({ cwd: session.sessionManager.getCwd(), sessionId: session.sessionId, remaining: outcome.remaining }, session);
  return true;
}

/** Text of a message's content parts, whatever dialect wrote them. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

/** What the end of one of the report's own model calls says about the run. */
function noteAssistantEnd(run: ScheduledRun, message: Record<string, unknown>): void {
  const responseId = typeof message.responseId === "string" ? message.responseId : "";
  if (responseId.startsWith(GATEWAY_REFUSAL_ID_PREFIX)) {
    run.refused = true;
    run.refusalText = textOfContent(message.content).trim() || run.refusalText;
  }
  // The last call decides: a retry that went through is not a failure.
  run.failure = message.stopReason === "error"
    ? describeProviderFailure(message.errorMessage)?.message ?? "the model request failed"
    : undefined;
}

function subscribeForScheduledOutput(session: AgentSession, chatId: string, projectId?: string | null): () => void {
  let assistantText = "";
  const tools = new Map<string, ToolRecord>();

  const unsubscribe = session.subscribe((event: unknown) => {
    const record = asRecord(event);
    if (!record) return;

    // Only a background turn reaches this listener - a foreground one takes the
    // session out of retention first - and in this session that is a schedule.
    // A retried turn starts again inside the same run, so keep the first start.
    if (record.type === "agent_start") {
      if (!scheduledRuns.has(session)) {
        // The helper that did the work may have written to the person already.
        const helperDeliveries = takeHelperDeliveries(chatId);
        scheduledRuns.set(session, {
          ownerChatId: chatId,
          projectId,
          startLeafId: session.sessionManager.getLeafId(),
          reachedTelegram: helperDeliveries.some((delivery) => delivery.kind === "text"),
          helperDeliveries,
        });
        // From here until it settles, this session's tools refuse to touch the schedules.
        markScheduledRunSession(session.sessionId);
      }
      return;
    }

    if (record.type === "message_end") {
      const message = asRecord(record.message);
      const details = asRecord(message?.details);
      const run = scheduledRuns.get(session);
      if (!run || !message) return;
      if (message.role === "custom" && message.customType === "subagent-notification") {
        if (typeof details?.description === "string") run.description ??= details.description;
        if (typeof details?.status === "string") run.childStatus ??= details.status;
        if (typeof details?.error === "string" && details.error.trim()) run.childError ??= details.error.trim();
        return;
      }
      if (message.role === "assistant") noteAssistantEnd(run, message);
      return;
    }

    if (record.type === "message_update") {
      const assistantEvent = asRecord(record.assistantMessageEvent);
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        assistantText += assistantEvent.delta;
      }
      return;
    }

    if (record.type === "tool_execution_start") {
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      tools.set(toolCallId, {
        toolCallId,
        toolName,
        input: getToolArgs(record),
        status: "running",
      });
      return;
    }

    if (record.type === "tool_execution_end") {
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const existing = tools.get(toolCallId);
      tools.set(toolCallId, {
        toolCallId,
        toolName,
        input: existing?.input ?? {},
        output: getToolResult(record),
        status: record.isError === true ? "error" : "completed",
      });
      return;
    }

    if (record.type === "agent_settled") {
      const text = assistantText;
      const completed = [...tools.values()];
      assistantText = "";
      tools.clear();
      const run = scheduledRuns.get(session) ?? {
        ownerChatId: chatId,
        projectId,
        startLeafId: undefined,
        reachedTelegram: false,
      };
      scheduledRuns.delete(session);
      unmarkScheduledRunSession(session.sessionId);
      void finishScheduledRun(session, run, text, completed).catch((error) => {
        console.error("Failed to persist scheduled pi turn:", error);
      });
    }
  });

  // A run this listener stops hearing - the session taken for a foreground turn
  // midway - must not outlive it: the next run would start from its leaf, and
  // a foreground send would count as the run's.
  return () => {
    unsubscribe();
    scheduledRuns.delete(session);
    unmarkScheduledRunSession(session.sessionId);
  };
}

function disposeRetained(key: string, entry: RetainedSession) {
  clearInterval(entry.interval);
  entry.unsubscribe();
  retained.delete(key);
  entry.session.dispose();
}

async function maybeDisposeWhenDone(key: string) {
  const entry = retained.get(key);
  if (!entry || entry.reloading) return;

  // The store changed while this session was busy. Reload it now that it is
  // not: reloading stops every helper the session has running, and one of
  // those may be a scheduled run.
  if (pendingScheduleReloads.has(entry.session)) {
    if (!entry.session.isIdle || hasRunningSubagents(entry.session)) return;
    pendingScheduleReloads.delete(entry.session);
    entry.reloading = true;
    try {
      await entry.session.reload();
    } finally {
      entry.reloading = false;
    }
  }

  const enabled = await hasEnabledSchedules(entry.session);
  if (enabled) {
    entry.reason = "schedule";
    entry.emptySince = undefined;
    entry.expiresAt = undefined;
    return;
  }

  if (entry.reason === "mcp-oauth") {
    if (entry.expiresAt && Date.now() >= entry.expiresAt && entry.session.isIdle) {
      disposeRetained(key, entry);
    }
    return;
  }

  if (!entry.session.isIdle || hasRunningSubagents(entry.session)) {
    entry.emptySince = undefined;
    return;
  }

  entry.emptySince ??= Date.now();
  if (Date.now() - entry.emptySince >= EMPTY_GRACE_MS) {
    disposeRetained(key, entry);
  }
}

/**
 * Reuse a retained scheduler session for a foreground chat turn. The session is
 * removed from host ownership but not disposed; call retainPiScheduleSession()
 * again after the prompt finishes.
 */
export function takeRetainedPiScheduleSession(chatId: string): AgentSession | undefined {
  const key = keyFor(chatId);
  const entry = retained.get(key);
  if (!entry) return undefined;
  clearInterval(entry.interval);
  entry.unsubscribe();
  retained.delete(key);
  lent.set(key, entry.session);
  return entry.session;
}

/**
 * Keep a Pi session alive only when pi-subagents has enabled scheduled jobs for
 * it. This lets pi-subagents own timers/spawning while Eggent only hosts the
 * session lifecycle.
 */
export async function retainPiScheduleSession(options: {
  chatId: string;
  projectId?: string | null;
  session: AgentSession;
}): Promise<boolean> {
  const key = keyFor(options.chatId);
  if (lent.get(key) === options.session) lent.delete(key);
  const promptsNormalized = await normalizePiScheduleStore(options.session);
  const reloadRequested = pendingScheduleReloads.delete(options.session);
  if (promptsNormalized || reloadRequested) {
    await options.session.reload();
  }

  if (!(await hasEnabledSchedules(options.session))) return false;

  const previous = retained.get(key);
  if (previous && previous.session !== options.session) {
    disposeRetained(key, previous);
  }

  const unsubscribe = subscribeForScheduledOutput(options.session, options.chatId, options.projectId);
  const interval = setInterval(() => {
    void maybeDisposeWhenDone(key).catch((error) => {
      console.error("Failed to monitor retained pi schedule session:", error);
    });
  }, POLL_MS);
  interval.unref?.();

  retained.set(key, {
    chatId: options.chatId,
    projectId: options.projectId,
    session: options.session,
    reason: "schedule",
    unsubscribe,
    interval,
  });

  return true;
}

/**
 * Keep a Pi session alive briefly while an MCP OAuth browser redirect is in
 * flight. pi-mcp-adapter stores the pending PKCE verifier/transport in memory,
 * so the next user message with the redirected localhost URL must reuse the
 * same session or auth-complete will fail with "No pending OAuth flow".
 */
export function retainPiMcpOAuthSession(options: {
  chatId: string;
  projectId?: string | null;
  session: AgentSession;
  ttlMs?: number;
}): boolean {
  const key = keyFor(options.chatId);
  const previous = retained.get(key);
  if (previous && previous.session !== options.session) {
    disposeRetained(key, previous);
  }

  const interval = setInterval(() => {
    void maybeDisposeWhenDone(key).catch((error) => {
      console.error("Failed to monitor retained pi MCP OAuth session:", error);
    });
  }, POLL_MS);
  interval.unref?.();

  retained.set(key, {
    chatId: options.chatId,
    projectId: options.projectId,
    session: options.session,
    reason: "mcp-oauth",
    unsubscribe: () => {},
    interval,
    expiresAt: Date.now() + (options.ttlMs ?? 6 * 60_000),
  });

  return true;
}

export function listRetainedPiScheduleSessions() {
  return [...retained.values()].map((entry) => ({
    chatId: entry.chatId,
    projectId: entry.projectId,
    sessionId: entry.session.sessionId,
    cwd: entry.session.sessionManager.getCwd(),
    reason: entry.reason,
  }));
}

async function scheduleContexts(options: { cwd?: string; scope?: "current" | "all" }) {
  if (options.scope !== "all") {
    return [{ projectId: null as string | null, projectName: "Current context", cwd: options.cwd || getWorkDir(null) }];
  }

  const projects = await getAllProjects();
  return [
    { projectId: null as string | null, projectName: "Orchestrator", cwd: getWorkDir(null) },
    ...projects.map((project) => ({ projectId: project.id, projectName: project.name, cwd: getWorkDir(project.id) })),
  ];
}

async function readScheduleStores(cwd: string) {
  let entries: string[];
  try {
    entries = await fs.readdir(scheduleStoreDir(cwd));
  } catch {
    return [];
  }

  const stores: Array<{ filePath: string; sessionId: string; data: ScheduleStoreFile }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(scheduleStoreDir(cwd), entry);
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf-8")) as ScheduleStoreFile;
      stores.push({ filePath, sessionId: entry.replace(/\.json$/, ""), data });
    } catch {
      // Ignore corrupt/stale stores.
    }
  }
  return stores;
}

function isScheduleSession(session: AgentSession, cwd: string, sessionId: string): boolean {
  return session.sessionId === sessionId
    && path.resolve(session.sessionManager.getCwd()) === path.resolve(cwd);
}

/**
 * Make the scheduler that armed a store agree with what a clear left in it.
 *
 * The scheduler keeps its own copy of the jobs, so a job taken out of the file
 * still fires until the session holding it re-reads the store - which is what
 * a reload does. Only that one session is touched. This used to dispose every
 * retained session in the directory, and every chat's schedules share the
 * directory of its project: deleting one reminder stopped every other job
 * there, while the list still showed them waiting.
 */
async function rearmAfterClear(
  store: { cwd: string; sessionId: string; remaining: number },
  currentSession?: AgentSession | null
): Promise<void> {
  // The turn that asked, and a turn running in the store's own chat, cannot be
  // reloaded from under themselves; theirs happens when the turn ends.
  if (currentSession && isScheduleSession(currentSession, store.cwd, store.sessionId)) {
    pendingScheduleReloads.add(currentSession);
    return;
  }
  for (const session of lent.values()) {
    if (isScheduleSession(session, store.cwd, store.sessionId)) {
      pendingScheduleReloads.add(session);
      return;
    }
  }
  for (const [key, entry] of retained) {
    if (!isScheduleSession(entry.session, store.cwd, store.sessionId)) continue;
    if (!entry.session.isIdle || hasRunningSubagents(entry.session) || entry.reloading) {
      pendingScheduleReloads.add(entry.session);
      return;
    }
    if (store.remaining === 0) {
      disposeRetained(key, entry);
      return;
    }
    entry.reloading = true;
    try {
      await entry.session.reload();
    } catch (error) {
      console.error(`[Schedules] Could not re-arm ${store.sessionId} after a clear:`, error);
    } finally {
      entry.reloading = false;
    }
    return;
  }
}

function findLiveScheduleSession(options: {
  cwd: string;
  sessionId: string;
  currentSession?: AgentSession | null;
}): AgentSession | null {
  if (options.currentSession && isScheduleSession(options.currentSession, options.cwd, options.sessionId)) {
    return options.currentSession;
  }
  for (const entry of retained.values()) {
    if (isScheduleSession(entry.session, options.cwd, options.sessionId)) return entry.session;
  }
  // A session lent to a turn of its own chat still holds the armed timers.
  for (const session of lent.values()) {
    if (isScheduleSession(session, options.cwd, options.sessionId)) return session;
  }
  return null;
}

export async function managePiSchedules(options: {
  action: "list" | "clear" | "update";
  cwd?: string;
  scope?: "current" | "all";
  jobId?: string;
  schedule?: string;
  prompt?: string;
  /** false switches a task off, true switches it back on. */
  enabled?: boolean;
  currentSession?: AgentSession | null;
}) {
  // The report of a scheduled run has every tool and no person: a model told
  // "do not touch the schedule" in a prompt it never read deleted the task it
  // was reporting on. Reading is fine; nothing else is.
  if (options.action !== "list" && isScheduledRunSession(options.currentSession)) {
    return {
      action: options.action,
      scope: options.scope ?? "current",
      refused: true,
      updated: false,
      rearmed: false,
      count: 0,
      schedules: [],
      error: SCHEDULED_RUN_REFUSAL,
    };
  }
  const contexts = await scheduleContexts({ cwd: options.cwd, scope: options.scope });
  const schedules: Array<ScheduleJobRecord & {
    projectId: string | null;
    projectName: string;
    sessionId: string;
    live: boolean;
  }> = [];
  const locations: Array<{
    context: Awaited<ReturnType<typeof scheduleContexts>>[number];
    store: Awaited<ReturnType<typeof readScheduleStores>>[number];
    job: ScheduleJobRecord;
  }> = [];
  let removed = 0;
  const cleared: Array<{ cwd: string; sessionId: string; remaining: number }> = [];
  const clearId = options.jobId?.trim();

  for (const context of contexts) {
    const stores = await readScheduleStores(context.cwd);
    for (const store of stores) {
      const jobs = store.data.jobs ?? [];
      for (const job of jobs) {
        const live = Boolean(findLiveScheduleSession({
          cwd: context.cwd,
          sessionId: store.sessionId,
          currentSession: options.currentSession,
        }));
        schedules.push({
          ...job,
          projectId: context.projectId,
          projectName: context.projectName,
          sessionId: store.sessionId,
          live,
        });
        locations.push({ context, store, job });
      }

      // With a job id only that job goes; without one the whole scope does.
      // The id used to be ignored here, so "delete this reminder" - from the
      // agent and from the Delete button alike - emptied every store in scope.
      if (options.action === "clear" && jobs.length > 0 && (!clearId || jobs.some((job) => job.id === clearId))) {
        const outcome = await mutateScheduleStore(store.filePath, (data) => {
          const before = data.jobs?.length ?? 0;
          data.jobs = clearId ? (data.jobs ?? []).filter((job) => job.id !== clearId) : [];
          const count = before - data.jobs.length;
          const remaining = data.jobs.filter((job) => job.enabled !== false).length;
          return { changed: count > 0, result: { count, remaining } };
        });
        removed += outcome.count;
        if (outcome.count > 0) {
          cleared.push({ cwd: context.cwd, sessionId: store.sessionId, remaining: outcome.remaining });
        }
      }
    }
  }

  if (options.action === "clear") {
    for (const store of cleared) await rearmAfterClear(store, options.currentSession);
    if (clearId && removed === 0) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        count: 0,
        schedules: [],
        error: `Scheduled job ${clearId} was not found in this scope; nothing was removed. List schedules with scope=all and use the exact job id.`,
      };
    }
  }

  if (options.action === "update") {
    const jobId = options.jobId?.trim();
    if (!jobId) throw new Error("job_id is required when action=update");
    const nextSchedule = options.schedule?.trim();
    const nextPrompt = options.prompt?.trim();
    const nextEnabled = typeof options.enabled === "boolean" ? options.enabled : undefined;
    if (!nextSchedule && !nextPrompt && nextEnabled === undefined) {
      throw new Error("action=update needs a new schedule, a new prompt, enabled, or a combination of them");
    }

    const matches = locations.filter((location) => location.job.id === jobId);
    if (matches.length === 0) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: false,
        rearmed: false,
        error: `Scheduled job ${jobId} was not found in this scope. List schedules with scope=all and use the exact job id.`,
      };
    }
    if (matches.length > 1) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: false,
        rearmed: false,
        error: `Scheduled job id ${jobId} is ambiguous across ${matches.length} stores.`,
      };
    }

    const target = matches[0];
    const targetSession = findLiveScheduleSession({
      cwd: target.context.cwd,
      sessionId: target.store.sessionId,
      currentSession: options.currentSession,
    });
    // Changing what a task says or when it runs needs the scheduler that holds
    // it. Switching one off needs nothing armed, and switching one on brings a
    // scheduler up for it below.
    if (!targetSession && (nextSchedule || nextPrompt)) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: false,
        rearmed: false,
        error: `Scheduled job ${jobId} is stored but its scheduler session is not live. Open its original chat before updating it.`,
      };
    }
    if (nextEnabled === true && !nextSchedule && target.job.scheduleType === "once" && Date.parse(String(target.job.schedule)) <= Date.now()) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: false,
        rearmed: false,
        error: `Scheduled job ${jobId} is a one-time task whose moment has passed. Give it a new time with schedule.`,
      };
    }

    // Only re-read the timing when a new one was asked for: parsing the stored
    // schedule again would turn a relative one-shot such as "+10m" into ten
    // minutes from *now* on every text edit.
    const detected = nextSchedule ? detectSchedule(nextSchedule) : null;
    const updatedJob = await mutateScheduleStore(target.store.filePath, (data) => {
      const job = (data.jobs ?? []).find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Scheduled job ${jobId} disappeared while it was being updated`);
      if (detected) {
        job.schedule = detected.schedule;
        job.scheduleType = detected.scheduleType;
        if (detected.intervalMs) job.intervalMs = detected.intervalMs;
        else delete job.intervalMs;
        if (detected.nextRun) job.nextRun = detected.nextRun;
        else delete job.nextRun;
      }
      if (nextPrompt) job.prompt = nextPrompt;
      // Always re-applied, never stacked: the directive is what stops a fired
      // job from re-creating itself instead of doing the work.
      if (job.prompt) job.prompt = withScheduleExecutionDirective(job.prompt);
      if (nextEnabled === false) {
        job.enabled = false;
        job.pausedBy = "user";
        job.pausedAt = new Date().toISOString();
        delete job.pausedReason;
        delete job.pausedDetail;
      }
      if (nextEnabled === true) {
        job.enabled = true;
        delete job.pausedBy;
        delete job.pausedReason;
        delete job.pausedAt;
        delete job.pausedDetail;
      }
      return { changed: true, result: { ...job } };
    });
    // A task switched back on starts from a clean record.
    if (nextEnabled === true) await forgetJobHealth(healthKey(target.store.sessionId, jobId)).catch(() => undefined);

    if (!targetSession) {
      // Nothing is armed for this store. Switching a task off leaves it so;
      // switching one on has to bring a scheduler up, the way a restart does.
      if (nextEnabled !== true) {
        return {
          action: options.action,
          scope: options.scope ?? "current",
          updated: true,
          rearmed: false,
          enabled: nextEnabled,
          job: updatedJob,
        };
      }
      const revived = await armScheduleStore(target.context, target.store.sessionId);
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: revived ? "started" : false,
        enabled: true,
        nextRun: updatedJob.nextRun,
        job: updatedJob,
        ...(revived ? {} : { error: "The task is switched on, but its scheduler could not be started. Try again, or open its original chat." }),
      };
    }

    if (targetSession === options.currentSession) {
      pendingScheduleReloads.add(targetSession);
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: "after_current_turn",
        nextRun: detected?.nextRun ?? updatedJob.nextRun,
        job: updatedJob,
      };
    }
    // Reloading stops every helper the session has running, and one of them may
    // be another task's run: wait until it is idle, as a delete does.
    if (targetSession.isIdle === false || hasRunningSubagents(targetSession)) {
      pendingScheduleReloads.add(targetSession);
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: "when_idle",
        nextRun: detected?.nextRun ?? updatedJob.nextRun,
        job: updatedJob,
      };
    }

    try {
      await targetSession.reload();
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: true,
        nextRun: detected?.nextRun ?? updatedJob.nextRun,
        job: updatedJob,
      };
    } catch (error) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: false,
        nextRun: detected?.nextRun ?? updatedJob.nextRun,
        job: updatedJob,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    action: options.action,
    scope: options.scope ?? "current",
    count: options.action === "clear" ? removed : schedules.length,
    schedules: options.action === "list" ? schedules : [],
  };
}

/**
 * Open the session a store is named after, so pi-subagents arms what is enabled
 * in it. A restart does this for every store at boot; switching a paused task
 * back on does it for one whose session was let go while nothing in it was
 * enabled.
 */
async function armScheduleStore(
  context: { projectId: string | null; projectName: string; cwd: string },
  sessionId: string
): Promise<boolean> {
  if (retained.has(keyFor(sessionId))) return true;
  try {
    const { createEggentPiSession } = await import("@/lib/pi/session");
    const session = await createEggentPiSession({
      chatId: sessionId,
      projectId: context.projectId ?? undefined,
      cwd: context.cwd,
    });
    const kept = await retainPiScheduleSession({ chatId: sessionId, projectId: context.projectId, session });
    if (!kept) session.dispose();
    return kept;
  } catch (error) {
    console.warn(
      `[Schedules] Could not restore ${sessionId} in ${context.projectName}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * Bring stored schedules back after a restart.
 *
 * A scheduled job is armed by pi-subagents inside a live session and dies with
 * it, so until this ran, every deploy, every sleep/wake and every crash quietly
 * ended every schedule on the machine while the store kept saying `enabled`.
 * Nothing read those files again, because a store is only opened by a session
 * carrying the same id.
 *
 * So at boot we open exactly those sessions again: one per store that still has
 * work in it, with the chat id the store is named after, which is what makes
 * pi-subagents arm it on session_start.
 */
export async function restorePiSchedules(): Promise<{ armed: number; expired: number; failed: number }> {
  const contexts = await scheduleContexts({ scope: "all" });
  let armed = 0;
  let expired = 0;
  let failed = 0;

  for (const context of contexts) {
    for (const store of await readScheduleStores(context.cwd)) {
      // A one-shot whose moment passed while the machine was down must not fire
      // on the way up: arming it would deliver yesterday's reminder at boot, and
      // a burst of them at once. Drop those first, then arm what is still ahead.
      const dropped = await mutateScheduleStore(store.filePath, (data) => {
        const before = data.jobs?.length ?? 0;
        data.jobs = (data.jobs ?? []).filter((job) => {
          if (job.scheduleType !== "once") return true;
          const at = Date.parse(String(job.schedule));
          return !Number.isFinite(at) || at > Date.now();
        });
        const removedCount = before - data.jobs.length;
        return { changed: removedCount > 0, result: removedCount };
      }).catch(() => 0);
      expired += dropped;

      const jobs = (await readScheduleStores(context.cwd))
        .find((entry) => entry.sessionId === store.sessionId)?.data.jobs ?? [];
      if (!jobs.some((job) => job.enabled !== false)) continue;
      if (retained.has(keyFor(store.sessionId))) continue;

      if (await armScheduleStore(context, store.sessionId)) armed += 1;
      else failed += 1;
    }
  }

  if (armed || expired || failed) {
    console.log(`[Schedules] Restored ${armed} scheduled job store(s); dropped ${expired} expired one-shot(s); ${failed} failed.`);
  }
  return { armed, expired, failed };
}
