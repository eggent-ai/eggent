import fs from "fs/promises";
import path from "path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { getAllProjects, getWorkDir } from "@/lib/storage/project-store";
import type { ChatMessage } from "@/lib/types";
import { resolveTelegramDestination, sendTelegramText } from "@/lib/telegram/outbound";

type ScheduleJobRecord = {
  id?: string;
  name?: string;
  description?: string;
  schedule?: string;
  scheduleType?: string;
  enabled?: boolean;
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
const POLL_MS = 5_000;
const EMPTY_GRACE_MS = 10 * 60_000;

function keyFor(chatId: string) {
  return chatId;
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

export async function managePiSchedules(options: {
  action: "list" | "clear";
  cwd?: string;
  scope?: "current" | "all";
}) {
  const contexts = await scheduleContexts({ cwd: options.cwd, scope: options.scope });
  const schedules: Array<ScheduleJobRecord & { projectId: string | null; projectName: string; sessionId: string }> = [];
  let removed = 0;

  for (const context of contexts) {
    const stores = await readScheduleStores(context.cwd);
    for (const store of stores) {
      const jobs = store.data.jobs ?? [];
      for (const job of jobs) {
        schedules.push({
          ...job,
          projectId: context.projectId,
          projectName: context.projectName,
          sessionId: store.sessionId,
        });
      }

      if (options.action === "clear" && jobs.length > 0) {
        removed += jobs.length;
        await fs.writeFile(store.filePath, JSON.stringify({ version: store.data.version ?? 1, jobs: [] }, null, 2), "utf-8");
      }
    }
  }

  if (options.action === "clear" && removed > 0) {
    disposeRetainedForCwds(contexts.map((context) => context.cwd));
  }

  return {
    action: options.action,
    scope: options.scope ?? "current",
    count: options.action === "clear" ? removed : schedules.length,
    schedules: options.action === "list" ? schedules : [],
  };
}
