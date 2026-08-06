import fs from "fs/promises";
import path from "path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { getAllProjects, getWorkDir } from "@/lib/storage/project-store";
import type { ChatMessage } from "@/lib/types";
import { resolveTelegramDestination, sendTelegramText } from "@/lib/telegram/outbound";
import { detectSchedule, withScheduleExecutionDirective } from "@/lib/pi/schedule-policy";

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
};

const retained = new Map<string, RetainedSession>();
const pendingScheduleReloads = new WeakSet<AgentSession>();
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

function scheduleStorePath(session: AgentSession): string {
  return path.join(
    session.sessionManager.getCwd(),
    ".pi",
    "subagent-schedules",
    `${session.sessionId}.json`
  );
}

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

function hasRunningSubagents(): boolean {
  try {
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    return Boolean(manager?.hasRunning?.());
  } catch {
    return false;
  }
}

async function persistScheduledTurn(chatId: string, assistantText: string, tools: ToolRecord[]) {
  const chat = await getChat(chatId);
  if (!chat) return;

  const completedTools = tools.filter((tool) => tool.status !== "running");
  if (!assistantText.trim() && completedTools.length === 0) return;

  const now = new Date().toISOString();
  const assistantMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: assistantText,
    createdAt: now,
    toolCalls: completedTools.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      args: normalizeToolInput(tool.input),
    })),
  };
  chat.messages.push(assistantMessage);

  for (const tool of completedTools) {
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

  await deliverScheduledTurnToTelegram(assistantText);
}

/**
 * Push the result of a scheduled run to Telegram, when this workspace has a
 * chat to push to.
 *
 * The delivery deliberately does not depend on the agent calling a tool. A
 * scheduled job runs as a subagent with its own tool list, which is why every
 * "write to me at 07:00" ever asked for here produced the same answer: the task
 * fired, and then reported that it had nothing to send with. The host knows
 * both the result and the destination, so it does the sending itself.
 */
async function deliverScheduledTurnToTelegram(assistantText: string): Promise<void> {
  const text = assistantText.trim();
  if (!text) return;

  try {
    const destination = await resolveTelegramDestination(null);
    if (!destination) return;
    const result = await sendTelegramText(destination, text);
    if (!result.success) {
      console.warn("Scheduled Telegram delivery failed:", result.error);
    }
  } catch (error) {
    console.warn("Scheduled Telegram delivery failed:", error);
  }
}

function subscribeForScheduledOutput(session: AgentSession, chatId: string): () => void {
  let assistantText = "";
  const tools = new Map<string, ToolRecord>();

  return session.subscribe((event: unknown) => {
    const record = asRecord(event);
    if (!record) return;

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
      void persistScheduledTurn(chatId, text, completed).catch((error) => {
        console.error("Failed to persist scheduled pi turn:", error);
      });
    }
  });
}

function disposeRetained(key: string, entry: RetainedSession) {
  clearInterval(entry.interval);
  entry.unsubscribe();
  retained.delete(key);
  entry.session.dispose();
}

async function maybeDisposeWhenDone(key: string) {
  const entry = retained.get(key);
  if (!entry) return;

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

  if (!entry.session.isIdle || hasRunningSubagents()) {
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
  const promptsNormalized = await normalizePiScheduleStore(options.session);
  const reloadRequested = pendingScheduleReloads.delete(options.session);
  if (promptsNormalized || reloadRequested) {
    await options.session.reload();
  }

  if (!(await hasEnabledSchedules(options.session))) return false;

  const key = keyFor(options.chatId);
  const previous = retained.get(key);
  if (previous && previous.session !== options.session) {
    disposeRetained(key, previous);
  }

  const unsubscribe = subscribeForScheduledOutput(options.session, options.chatId);
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

function disposeRetainedForCwds(cwds: string[]) {
  const normalized = new Set(cwds.map((cwd) => path.resolve(cwd)));
  for (const [key, entry] of retained) {
    if (normalized.has(path.resolve(entry.session.sessionManager.getCwd()))) {
      disposeRetained(key, entry);
    }
  }
}

function isScheduleSession(session: AgentSession, cwd: string, sessionId: string): boolean {
  return session.sessionId === sessionId
    && path.resolve(session.sessionManager.getCwd()) === path.resolve(cwd);
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
  return null;
}

export async function managePiSchedules(options: {
  action: "list" | "clear" | "update";
  cwd?: string;
  scope?: "current" | "all";
  jobId?: string;
  schedule?: string;
  currentSession?: AgentSession | null;
}) {
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

      if (options.action === "clear" && jobs.length > 0) {
        removed += await mutateScheduleStore(store.filePath, (data) => {
          const count = data.jobs?.length ?? 0;
          data.jobs = [];
          return { changed: count > 0, result: count };
        });
      }
    }
  }

  if (options.action === "clear" && removed > 0) {
    disposeRetainedForCwds(contexts.map((context) => context.cwd));
  }

  if (options.action === "update") {
    const jobId = options.jobId?.trim();
    if (!jobId) throw new Error("job_id is required when action=update");
    if (!options.schedule?.trim()) throw new Error("schedule is required when action=update");

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
    if (!targetSession) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: false,
        rearmed: false,
        error: `Scheduled job ${jobId} is stored but its scheduler session is not live. Open its original chat before updating it.`,
      };
    }

    const detected = detectSchedule(options.schedule);
    const updatedJob = await mutateScheduleStore(target.store.filePath, (data) => {
      const job = (data.jobs ?? []).find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Scheduled job ${jobId} disappeared while it was being updated`);
      job.schedule = detected.schedule;
      job.scheduleType = detected.scheduleType;
      if (detected.intervalMs) job.intervalMs = detected.intervalMs;
      else delete job.intervalMs;
      if (detected.nextRun) job.nextRun = detected.nextRun;
      else delete job.nextRun;
      if (job.prompt) job.prompt = withScheduleExecutionDirective(job.prompt);
      return { changed: true, result: { ...job } };
    });

    if (targetSession === options.currentSession) {
      pendingScheduleReloads.add(targetSession);
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: "after_current_turn",
        nextRun: detected.nextRun,
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
        nextRun: detected.nextRun,
        job: updatedJob,
      };
    } catch (error) {
      return {
        action: options.action,
        scope: options.scope ?? "current",
        updated: true,
        rearmed: false,
        nextRun: detected.nextRun,
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
