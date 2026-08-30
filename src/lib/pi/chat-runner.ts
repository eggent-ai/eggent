import { createUIMessageStream } from "ai";
import type { UIMessage } from "ai";
import { createEggentPiSession } from "@/lib/pi/session";
import { diagnoseCurrentProvider, getPiModelsState, managedCredentialRecoverable } from "@/lib/pi/config-store";
import { getServerTranslator } from "@/i18n/server";
import { cancelPendingInteractionsForRun } from "@/lib/pi/pending-interactions";
import { retainPiMcpOAuthSession, retainPiScheduleSession, takeRetainedPiScheduleSession } from "@/lib/pi/schedule-host";
import { clearActiveRun, getActiveRun, isStopRequest, registerActiveRun } from "@/lib/pi/active-runs";
import { applySchedulingToolPolicy, hasScheduleIntent, hasScheduleManagementIntent } from "@/lib/pi/schedule-intent";
import { describeProviderFailure, type ProviderFailure } from "@/lib/pi/provider-failure";
import type { PiChatRunOptions, PiRuntimeStats, PiToolRecord } from "@/lib/pi/types";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { clearUsageSnapshotCache } from "@/lib/usage/usage-provider";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

async function formatPiChatError(error: unknown): Promise<string> {
  const t = await getServerTranslator();
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, " ").trim();
  const message = compact || t("chat.errors.stoppedEarly");
  const short = message.length > 500 ? `${message.slice(0, 500)}...` : message;
  return t("chat.errors.generationFailed", { details: short });
}

export interface EggentActionNotice {
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
}

/**
 * Providers may attach an actionable notice to a failure, for example when a
 * managed deployment refuses a request because a quota is exhausted. Eggent does
 * not interpret the reason — it only forwards the notice so the UI can render an
 * action instead of dumping a raw provider error into the chat.
 */
export function extractEggentNotice(error: unknown): EggentActionNotice | null {
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw.includes("eggent_notice")) return null;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  for (let cursor = end; cursor > start; cursor = raw.lastIndexOf("}", cursor - 1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, cursor + 1));
    } catch {
      continue;
    }

    const queue: unknown[] = [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;

      const candidate = record.eggent_notice;
      if (candidate && typeof candidate === "object") {
        const notice = candidate as Record<string, unknown>;
        const title = typeof notice.title === "string" ? notice.title.trim() : "";
        const body = typeof notice.body === "string" ? notice.body.trim() : "";
        if (title || body) {
          const actionUrl = typeof notice.actionUrl === "string" ? notice.actionUrl.trim() : "";
          return {
            level: notice.level === "critical" || notice.level === "warning" ? notice.level : "info",
            title,
            body,
            actionLabel: typeof notice.actionLabel === "string" ? notice.actionLabel.trim() || undefined : undefined,
            actionUrl: /^https?:\/\//i.test(actionUrl) ? actionUrl : undefined,
          };
        }
      }

      for (const value of Object.values(record)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
  }

  return null;
}

function getToolArgs(event: Record<string, unknown>) {
  return event.args ?? event.input ?? {};
}

function getToolResult(event: Record<string, unknown>) {
  return event.result ?? event.output ?? event.partialResult ?? "";
}

function numberFromRecord(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function usageTotal(usage: PiRuntimeStats["lastTurn"]): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.total === "number") return usage.total;
  const total = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .filter((item): item is number => typeof item === "number")
    .reduce((sum, item) => sum + item, 0);
  return total > 0 ? total : undefined;
}

function normalizeUsage(parts: PiRuntimeStats["lastTurn"]): PiRuntimeStats["lastTurn"] | undefined {
  if (!parts) return undefined;
  const total = usageTotal(parts);
  if (
    parts.input === undefined &&
    parts.output === undefined &&
    parts.cacheRead === undefined &&
    parts.cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return { ...parts, total };
}

function asUsage(value: unknown): PiRuntimeStats["lastTurn"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return normalizeUsage({
    input: numberFromRecord(record, ["input", "inputTokens", "promptTokens", "prompt_tokens"]),
    output: numberFromRecord(record, ["output", "outputTokens", "completionTokens", "completion_tokens"]),
    cacheRead: numberFromRecord(record, ["cacheRead", "cacheReadInputTokens", "cachedInputTokens", "cache_read_input_tokens"]),
    cacheWrite: numberFromRecord(record, ["cacheWrite", "cacheWriteInputTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"]),
    total: numberFromRecord(record, ["total", "totalTokens", "total_tokens"]),
  });
}

function formatTokenCount(value?: number): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function addUsage(
  left?: PiRuntimeStats["lastTurn"],
  right?: PiRuntimeStats["lastTurn"]
): PiRuntimeStats["lastTurn"] | undefined {
  if (!left && !right) return undefined;
  const sum = (field: keyof NonNullable<PiRuntimeStats["lastTurn"]>) => {
    const leftValue = left && typeof left[field] === "number" ? left[field] : 0;
    const rightValue = right && typeof right[field] === "number" ? right[field] : 0;
    const value = leftValue + rightValue;
    return value > 0 ? value : undefined;
  };
  return normalizeUsage({
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    total: sum("total"),
  });
}

function subtractUsage(
  after?: PiRuntimeStats["lastTurn"],
  before?: PiRuntimeStats["lastTurn"]
): PiRuntimeStats["lastTurn"] | undefined {
  if (!after) return undefined;
  const diff = (field: keyof NonNullable<PiRuntimeStats["lastTurn"]>) => {
    const afterValue = after[field];
    if (typeof afterValue !== "number") return undefined;
    const beforeValue = before && typeof before[field] === "number" ? before[field] : 0;
    return Math.max(0, afterValue - beforeValue);
  };
  return normalizeUsage({
    input: diff("input"),
    output: diff("output"),
    cacheRead: diff("cacheRead"),
    cacheWrite: diff("cacheWrite"),
    total: diff("total"),
  });
}

function getSessionTokenUsage(session: {
  getSessionStats?: () => { tokens?: PiRuntimeStats["lastTurn"] };
}): PiRuntimeStats["lastTurn"] | undefined {
  try {
    return normalizeUsage(session.getSessionStats?.().tokens);
  } catch {
    return undefined;
  }
}

function buildPiRuntimeStats(session: {
  model?: { provider?: string; id?: string; name?: string };
  getSessionStats?: () => {
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
    cost?: number;
    contextUsage?: PiRuntimeStats["context"];
  };
  getContextUsage?: () => PiRuntimeStats["context"] | undefined;
}, lastTurn?: PiRuntimeStats["lastTurn"], sessionUsageOverride?: PiRuntimeStats["session"]): PiRuntimeStats {
  let sessionStats: ReturnType<NonNullable<typeof session.getSessionStats>> | undefined;
  try {
    sessionStats = session.getSessionStats?.();
  } catch {
    sessionStats = undefined;
  }

  let context: PiRuntimeStats["context"] | undefined = sessionStats?.contextUsage;
  if (!context) {
    try {
      context = session.getContextUsage?.();
    } catch {
      context = undefined;
    }
  }

  return {
    model: session.model
      ? {
          provider: session.model.provider,
          id: session.model.id,
          name: session.model.name,
        }
      : undefined,
    lastTurn,
    session: sessionUsageOverride ?? (sessionStats?.tokens
      ? {
          input: sessionStats.tokens.input,
          output: sessionStats.tokens.output,
          cacheRead: sessionStats.tokens.cacheRead,
          cacheWrite: sessionStats.tokens.cacheWrite,
          total: sessionStats.tokens.total,
          cost: sessionStats.cost,
        }
      : undefined),
    context,
  };
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return asRecord(input) ?? {};
}

function getToolResultDetails(output: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(output)?.details);
}

function isMcpOAuthStartResult(toolName: string, output: unknown): boolean {
  if (toolName !== "mcp") return false;
  const details = getToolResultDetails(output);
  return details?.mode === "auth-start" && typeof details.authorizationUrl === "string";
}

function isMcpOAuthCompleteResult(toolName: string, output: unknown): boolean {
  if (toolName !== "mcp") return false;
  const details = getToolResultDetails(output);
  return details?.mode === "auth-complete" && details.authenticated === true;
}

function appendTimelineText(parts: ChatMessagePart[], delta: string): void {
  if (!delta) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    last.text += delta;
    return;
  }
  parts.push({ type: "text", text: delta });
}

function upsertTimelineTool(parts: ChatMessagePart[], tool: PiToolRecord): void {
  const existing = parts.find(
    (part): part is Extract<ChatMessagePart, { type: "tool" }> =>
      part.type === "tool" && part.toolCallId === tool.toolCallId
  );
  const next = {
    type: "tool" as const,
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    args: normalizeToolInput(tool.input),
    output: tool.output,
    status: tool.status,
  };
  if (existing) {
    existing.toolName = next.toolName;
    existing.args = next.args;
    existing.output = next.output;
    existing.status = next.status;
  } else {
    parts.push(next);
  }
}

function completedTimelineParts(parts: ChatMessagePart[]): ChatMessagePart[] {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text ? part : null;
      }
      if (part.status === "running") return null;
      return part;
    })
    .filter((part): part is ChatMessagePart => Boolean(part));
}

function isEmptyZeroTokenTurn(
  assistantText: string,
  tools: Iterable<PiToolRecord>,
  usage?: PiRuntimeStats["lastTurn"]
): boolean {
  if (assistantText.trim()) return false;
  for (const tool of tools) {
    if (tool.status === "completed" || tool.status === "error") return false;
  }
  return (usage?.total ?? 0) === 0 && (usage?.input ?? 0) === 0 && (usage?.output ?? 0) === 0;
}

/**
 * Why a turn produced nothing, checked against the workspace's own settings first.
 *
 * A zero-token turn usually means the selected provider cannot be reached at
 * all, and by far the most common reason is that it has no credential in this
 * workspace - something we can verify rather than guess at. Blaming the
 * provider for it sent at least one user to disconnect and re-add providers
 * until they had none left, so name the real cause when we know it.
 *
 * When settings alone cannot explain it, ask the provider: its own model list
 * separates a dead address from a rejected key from a model id it does not
 * have. The generic "maybe rate limits, maybe quota, maybe the key" is the last
 * resort, not the first answer, because it leaves people to try all three.
 *
 * Every one of these leaves the workspace unable to answer at all, so each ends
 * with the way back to the included model when this workspace still has it.
 */
async function emptyTurnError(failure?: ProviderFailure | null): Promise<Error> {
  const t = await getServerTranslator();

  const withFallback = async (message: string): Promise<Error> => {
    try {
      if (await managedCredentialRecoverable()) {
        return new Error(`${message} ${t("chat.errors.returnToIncluded")}`);
      }
    } catch {
      // The hint is a courtesy; never let it replace the real message.
    }
    return new Error(message);
  };

  try {
    const state = await getPiModelsState();
    const provider = state.settings?.defaultProvider?.trim();
    if (!provider) {
      return await withFallback(t("chat.errors.noModelSelected"));
    }
    const name = state.providers?.find((item) => item.id === provider)?.name || provider;

    // The provider's own words outrank everything below. Settings checks and the
    // probe exist to work out what went wrong when nothing said; when something
    // did say, guessing over it is how "your key may be wrong" got shown to a
    // user whose key was fine and whose service account had been disabled.
    if (failure?.message) {
      return await withFallback(
        failure.status
          ? t("chat.errors.providerRefusedWithStatus", {
              provider: name,
              status: String(failure.status),
              details: failure.message,
            })
          : t("chat.errors.providerRefused", { provider: name, details: failure.message })
      );
    }

    const connected = (state.availableModels ?? []).some((model) => model.provider === provider);
    if (!connected) {
      return await withFallback(t("chat.errors.providerNoCredential", { provider: name }));
    }

    const probe = await diagnoseCurrentProvider();
    if (probe && !probe.ok) {
      if (probe.localOnly) {
        return await withFallback(t("chat.errors.providerLocalOnly", { provider: name }));
      }
      if (probe.reason === "unreachable") {
        return await withFallback(t("chat.errors.providerUnreachable", { provider: name }));
      }
      if (probe.reason === "unauthorized") {
        return await withFallback(t("chat.errors.providerRejectedKey", { provider: name }));
      }
      if (probe.reason === "model_missing") {
        return await withFallback(
          t("chat.errors.providerModelMissing", {
            provider: name,
            model: probe.model || "",
            models: (probe.models || []).slice(0, 8).join(", "),
          })
        );
      }
    }
  } catch {
    // Fall through to the generic message rather than hiding the original failure.
  }
  return await withFallback(t("chat.errors.emptyResponse"));
}

function isDefaultChatTitle(title: string): boolean {
  return ["New Chat", "New chat"].includes(title.trim());
}

function titleFromFirstMessage(message: string): string {
  return message.slice(0, 60) + (message.length > 60 ? "..." : "");
}

function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function hasMcpOAuthCallbackUrl(text: string): boolean {
  return /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/[^\s]*callback[^\s]*[?&](code|state)=/i.test(text);
}

function preparePromptForRuntime(text: string): string {
  // Runtime slash commands such as /skill:name and prompt templates must stay
  // at the very beginning of the message so the SDK can expand them.
  if (isSlashCommand(text)) return text;
  if (hasMcpOAuthCallbackUrl(text)) {
    return [
      "Eggent MCP OAuth callback directive:",
      "- The user message appears to be a redirected localhost OAuth callback URL for a pending MCP authentication flow.",
      "- Do not start a new OAuth flow and do not search the web.",
      "- Use the existing pending MCP flow in this same chat by calling the mcp proxy tool with action=\"auth-complete\" and args containing the full redirectUrl exactly as provided.",
      "- If the current project has exactly one configured MCP server, use that server. If the previous assistant/tool output named a server, use that same server.",
      "- After successful auth-complete, call mcp({ connect: \"<server>\" }) to verify it is ready.",
      "",
      "User message:",
      text,
    ].join("\n");
  }
  if (hasScheduleManagementIntent(text)) {
    return [
      "Eggent schedule-management directive:",
      "- This user request asks to inspect or modify existing scheduled tasks.",
      "- Do not create a new scheduled Agent for this request and never edit .pi/subagent-schedules files directly.",
      "- Use eggent_manage_schedules with action=\"list\", action=\"update\", or action=\"clear\".",
      "- To change a task, list with scope=\"all\", wait for the result, then call update with the exact job_id and new schedule.",
      "- For requests like 'убери все запланированные задачи', call clear with scope=\"all\" unless the user explicitly says current project only.",
      "",
      "User request:",
      text,
    ].join("\n");
  }

  if (!hasScheduleIntent(text)) return text;
  return [
    "Eggent scheduling directive:",
    "- This user request asks for delayed/scheduled execution.",
    "- Do not emulate scheduling with bash, sleep, shell loops, at, or OS cron.",
    "- Use pi-subagents by calling the Agent tool with its schedule parameter (for example schedule=\"+30s\" or a 6-field cron expression).",
    "- The scheduled Agent prompt should contain only the actual work to perform at fire time, not instructions to create or modify a schedule.",
    "",
    "User request:",
    text,
  ].join("\n");
}

async function persistUserMessage(options: PiChatRunOptions, userMessageId: string) {
  const chat = await getChat(options.chatId);
  if (!chat) return;

  if (chat.messages.some((message) => message.id === userMessageId)) return;

  const now = new Date().toISOString();
  chat.messages.push({
    id: userMessageId,
    role: "user",
    content: options.userMessage,
    createdAt: now,
  });

  const userMessageCount = chat.messages.filter((message) => message.role === "user").length;
  if (userMessageCount === 1 && isDefaultChatTitle(chat.title)) {
    chat.title = titleFromFirstMessage(options.userMessage);
  }

  chat.updatedAt = now;
  await saveChat(chat);
}

async function persistAssistantMessage(options: {
  chatId: string;
  assistantText: string;
  tools: PiToolRecord[];
  runtimeStats?: PiRuntimeStats;
  parts?: ChatMessagePart[];
}) {
  const chat = await getChat(options.chatId);
  if (!chat) return;

  const now = new Date().toISOString();
  const completedTools = options.tools.filter((tool) => tool.status !== "running");

  if (options.assistantText.trim() || completedTools.length > 0 || options.runtimeStats) {
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: options.assistantText,
      createdAt: now,
      toolCalls: completedTools.map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: normalizeToolInput(tool.input),
      })),
      parts: completedTimelineParts(options.parts ?? []),
      piRuntimeStats: options.runtimeStats,
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
  }

  chat.updatedAt = now;
  await saveChat(chat);
}

/**
 * What to do with a message that arrives while this chat already has an agent working.
 *
 * Starting a second agent was the old answer and it was the wrong one: neither
 * could see the other, so a request to stop went to a fresh session that had
 * nothing to stop, while the real run kept going. The runtime has both of the
 * primitives needed here and we were using neither.
 *
 * - A stop is honoured immediately, because that is the whole point of saying it.
 * - Anything else is steered into the running turn: it lands after the current
 *   tool calls and before the next model call, which is where a correction is
 *   still worth something. Queuing it until the end (followUp) would let the
 *   agent finish doing the thing the user was trying to redirect.
 *
 * Returns null when there was no run to join, so the caller starts one normally.
 */
export async function joinActiveRun(
  chatId: string,
  message: string
): Promise<"stopped" | "steered" | null> {
  const active = getActiveRun(chatId);
  if (!active) return null;

  if (isStopRequest(message)) {
    await active.session.abort().catch((error) => {
      console.warn("Failed to abort the running turn:", error);
    });
    clearActiveRun(chatId, active.runId);
    return "stopped";
  }

  // Extension commands cannot be steered - the runtime refuses them - and a
  // slash command is a new instruction anyway, so let it start its own run.
  if (message.trimStart().startsWith("/")) return null;

  try {
    await active.session.steer(message);
    return "steered";
  } catch (error) {
    console.warn("Failed to steer the running turn, starting a new one:", error);
    return null;
  }
}

export async function runPiAgentText(options: PiChatRunOptions & { runtimeData?: Record<string, unknown>; toolRuntimeData?: Record<string, unknown> }): Promise<string> {
  const userMessageId = crypto.randomUUID();
  const runId = options.runId ?? crypto.randomUUID();
  const prompt = options.runtimeData
    ? `${options.userMessage}\n\nRuntime data:\n${JSON.stringify(options.runtimeData, null, 2)}`
    : options.userMessage;

  await persistUserMessage({ ...options, userMessage: prompt }, userMessageId);

  const session = takeRetainedPiScheduleSession(options.chatId) ?? await createEggentPiSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    tools: options.tools,
    chatId: options.chatId,
    projectId: options.projectId,
    toolRuntimeData: options.toolRuntimeData,
    runId,
    abortSignal: options.abortSignal,
  });

  let assistantText = "";
  let lastTurnUsage: PiRuntimeStats["lastTurn"] | undefined;
  let currentPromptUsage: PiRuntimeStats["lastTurn"] | undefined;
  let providerFailure: ProviderFailure | null = null;
  const baselineUsage = getSessionTokenUsage(session);
  const tools = new Map<string, PiToolRecord>();
  const timelineParts: ChatMessagePart[] = [];
  let mcpOAuthPending = false;

  const unsubscribe = session.subscribe((event: unknown) => {
    const record = asRecord(event);
    if (!record) return;

    if (record.type === "message_update") {
      const assistantEvent = asRecord(record.assistantMessageEvent);
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        assistantText += assistantEvent.delta;
        appendTimelineText(timelineParts, assistantEvent.delta);
      }
      return;
    }

    if (record.type === "message_end") {
      const message = asRecord(record.message);
      if (message?.role === "assistant") {
        const usage = asUsage(message.usage);
        lastTurnUsage = usage ?? lastTurnUsage;
        currentPromptUsage = addUsage(currentPromptUsage, usage);
        // A refusal arrives as a message like any other, carrying the reason.
        // Keep the last one: a retried turn ends on whichever attempt stopped.
        providerFailure =
          message.stopReason === "error"
            ? describeProviderFailure(message.errorMessage) ?? providerFailure
            : null;
      }
      return;
    }

    if (record.type === "tool_execution_start") {
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const toolRecord: PiToolRecord = {
        toolCallId,
        toolName,
        input: getToolArgs(record),
        status: "running",
      };
      tools.set(toolCallId, toolRecord);
      upsertTimelineTool(timelineParts, toolRecord);
      return;
    }

    if (record.type === "tool_execution_end") {
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const existing = tools.get(toolCallId);
      const output = getToolResult(record);
      const toolRecord: PiToolRecord = {
        toolCallId,
        toolName,
        input: existing?.input ?? {},
        output,
        status: record.isError === true ? "error" : "completed",
      };
      if (!record.isError && isMcpOAuthStartResult(toolName, output)) {
        mcpOAuthPending = true;
      } else if (!record.isError && isMcpOAuthCompleteResult(toolName, output)) {
        mcpOAuthPending = false;
      }
      tools.set(toolCallId, toolRecord);
      upsertTimelineTool(timelineParts, toolRecord);
    }
  });

  try {
    applySchedulingToolPolicy(session, prompt);
    // Reachable while it runs, so a second message can stop it or be added to
    // it instead of starting a rival agent in the same chat.
    registerActiveRun(options.chatId, { session, runId, surface: "external" });
    await session.prompt(preparePromptForRuntime(prompt));
    currentPromptUsage = currentPromptUsage ?? subtractUsage(getSessionTokenUsage(session), baselineUsage);
    lastTurnUsage = lastTurnUsage ?? currentPromptUsage;
    if (isEmptyZeroTokenTurn(assistantText, tools.values(), currentPromptUsage)) {
      throw await emptyTurnError(providerFailure);
    }
    await persistAssistantMessage({
      chatId: options.chatId,
      assistantText,
      tools: [...tools.values()],
      runtimeStats: buildPiRuntimeStats(session, currentPromptUsage, addUsage(baselineUsage, currentPromptUsage)),
      parts: timelineParts,
    });
    return assistantText;
  } finally {
    clearActiveRun(options.chatId, runId);
    cancelPendingInteractionsForRun(runId);
    unsubscribe();
    const retained = await retainPiScheduleSession({
      chatId: options.chatId,
      projectId: options.projectId,
      session,
    });
    const retainedForMcpOAuth = !retained && mcpOAuthPending
      ? retainPiMcpOAuthSession({
          chatId: options.chatId,
          projectId: options.projectId,
          session,
        })
      : false;
    if (!retained && !retainedForMcpOAuth) session.dispose();
  }
}

export function createPiChatUIMessageStream(options: PiChatRunOptions) {
  const userMessageId = crypto.randomUUID();
  const runId = options.runId ?? crypto.randomUUID();

  return createUIMessageStream<UIMessage>({
    async execute({ writer }) {
      await persistUserMessage(options, userMessageId);

      let aborted = options.abortSignal?.aborted === true;
      let persisted = false;
      let abortPromise: Promise<void> | null = null;

      const safeWrite = (part: Parameters<typeof writer.write>[0]) => {
        if (aborted) return;
        writer.write(part);
      };

      // The composer is disabled while this tab's own turn runs, so a message
      // arriving here during one came from somewhere else - the same chat open
      // in Telegram, or a second tab. Join that run rather than starting a
      // rival agent in the same working directory.
      const joined = await joinActiveRun(options.chatId, options.userMessage);
      if (joined) {
        const t = await getServerTranslator();
        const textId = `pi-text-${crypto.randomUUID()}`;
        writer.write({ type: "text-start", id: textId });
        writer.write({
          type: "text-delta",
          id: textId,
          delta: joined === "stopped" ? t("external.run.stopped") : t("external.run.steered"),
        });
        writer.write({ type: "text-end", id: textId });
        return;
      }

      const session = takeRetainedPiScheduleSession(options.chatId) ?? await createEggentPiSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        tools: options.tools,
        chatId: options.chatId,
        projectId: options.projectId,
        runId,
        abortSignal: options.abortSignal,
        onPiInteraction: (interaction) => {
          safeWrite({
            type: "data-piInteraction",
            id: `pi-interaction-${interaction.id}`,
            data: interaction,
          });
        },
      });

      let assistantText = "";
      let textStarted = false;
      let currentTextId: string | null = null;
      let lastTurnUsage: PiRuntimeStats["lastTurn"] | undefined;
      let currentPromptUsage: PiRuntimeStats["lastTurn"] | undefined;
      let providerFailure: ProviderFailure | null = null;
      const baselineUsage = getSessionTokenUsage(session);
      const tools = new Map<string, PiToolRecord>();
      const timelineParts: ChatMessagePart[] = [];
      let mcpOAuthPending = false;

      const emitStats = (stats: PiRuntimeStats) => {
        safeWrite({
          type: "data-piStats",
          id: "pi-runtime-stats",
          data: stats,
        });
      };

      const ensureTextStarted = () => {
        if (textStarted && currentTextId) return currentTextId;
        currentTextId = `pi-text-${crypto.randomUUID()}`;
        textStarted = true;
        safeWrite({ type: "text-start", id: currentTextId });
        return currentTextId;
      };

      const closeTextPart = () => {
        if (!textStarted || !currentTextId) return;
        safeWrite({ type: "text-end", id: currentTextId });
        textStarted = false;
        currentTextId = null;
      };

      const currentStats = () => buildPiRuntimeStats(
        session,
        currentPromptUsage ?? lastTurnUsage,
        addUsage(baselineUsage, currentPromptUsage)
      );

      const persistPartialAssistant = async (runtimeStats: PiRuntimeStats = currentStats()) => {
        if (persisted) return;
        persisted = true;
        closeTextPart();
        await persistAssistantMessage({
          chatId: options.chatId,
          assistantText,
          tools: [...tools.values()],
          runtimeStats,
          parts: completedTimelineParts(timelineParts),
        });
      };

      const abortSession = () => {
        if (aborted && abortPromise) return abortPromise;
        aborted = true;
        cancelPendingInteractionsForRun(runId);
        abortPromise = (async () => {
          try {
            await session.abort();
          } catch (error) {
            console.warn("Pi chat abort failed:", error);
          }
        })();
        return abortPromise;
      };

      const handleAbort = () => {
        void abortSession();
      };

      options.abortSignal?.addEventListener("abort", handleAbort, { once: true });

      emitStats(buildPiRuntimeStats(session));

      const unsubscribe = session.subscribe((event: unknown) => {
        const record = asRecord(event);
        if (!record) return;

        if (record.type === "message_update") {
          const assistantEvent = asRecord(record.assistantMessageEvent);
          if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
            const textId = ensureTextStarted();
            assistantText += assistantEvent.delta;
            appendTimelineText(timelineParts, assistantEvent.delta);
            safeWrite({ type: "text-delta", id: textId, delta: assistantEvent.delta });
          }
          return;
        }

        if (record.type === "message_end") {
          const message = asRecord(record.message);
          if (message?.role === "assistant") {
            const usage = asUsage(message.usage);
            lastTurnUsage = usage ?? lastTurnUsage;
            currentPromptUsage = addUsage(currentPromptUsage, usage);
            // See the note on the other subscriber: the reason a turn produced
            // nothing arrives here and is worth more than any guess about it.
            providerFailure =
              message.stopReason === "error"
                ? describeProviderFailure(message.errorMessage) ?? providerFailure
                : null;
            emitStats(buildPiRuntimeStats(session, currentPromptUsage, addUsage(baselineUsage, currentPromptUsage)));
          }
          return;
        }

        if (record.type === "agent_end") {
          emitStats(buildPiRuntimeStats(session, currentPromptUsage ?? lastTurnUsage, addUsage(baselineUsage, currentPromptUsage)));
          return;
        }

        if (record.type === "compaction_start") {
          const reason = typeof record.reason === "string" ? record.reason : "threshold";
          safeWrite({
            type: "data-piCompaction",
            id: `pi-compaction-${crypto.randomUUID()}`,
            data: {
              state: "running",
              reason,
              message: reason === "manual" ? "Сжимаю историю чата…" : "Сжимаю контекст, чтобы продолжить без переполнения…",
              timestamp: new Date().toISOString(),
            },
          });
          return;
        }

        if (record.type === "compaction_end") {
          const reason = typeof record.reason === "string" ? record.reason : "threshold";
          const result = asRecord(record.result);
          const tokensBefore = numberFromRecord(result ?? {}, ["tokensBefore"]);
          const estimatedTokensAfter = numberFromRecord(result ?? {}, ["estimatedTokensAfter"]);
          const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : undefined;
          const abortedCompaction = record.aborted === true;
          const state = errorMessage || abortedCompaction ? "failed" : "completed";
          const beforeText = tokensBefore !== undefined ? formatTokenCount(tokensBefore) : "—";
          const afterText = estimatedTokensAfter !== undefined ? formatTokenCount(estimatedTokensAfter) : "—";
          safeWrite({
            type: "data-piCompaction",
            id: `pi-compaction-${crypto.randomUUID()}`,
            data: {
              state,
              reason,
              tokensBefore,
              estimatedTokensAfter,
              message: state === "completed"
                ? `Контекст сжат: было ${beforeText}, стало примерно ${afterText} токенов.`
                : `Не удалось сжать контекст${errorMessage ? `: ${errorMessage}` : "."}`,
              timestamp: new Date().toISOString(),
            },
          });
          return;
        }

        if (record.type === "tool_execution_start") {
          const toolCallId =
            typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
          const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
          const input = getToolArgs(record);
          const toolRecord: PiToolRecord = {
            toolCallId,
            toolName,
            input,
            status: "running",
          };
          tools.set(toolCallId, toolRecord);
          closeTextPart();
          upsertTimelineTool(timelineParts, toolRecord);
          safeWrite({
            type: "tool-input-available",
            toolCallId,
            toolName,
            input,
            dynamic: true,
          });
          return;
        }

        if (record.type === "tool_execution_end") {
          const toolCallId =
            typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
          const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
          const output = getToolResult(record);
          const isError = record.isError === true;
          const existing = tools.get(toolCallId);
          const toolRecord: PiToolRecord = {
            toolCallId,
            toolName,
            input: existing?.input ?? {},
            output,
            status: isError ? "error" : "completed",
          };
          if (!isError && isMcpOAuthStartResult(toolName, output)) {
            mcpOAuthPending = true;
          } else if (!isError && isMcpOAuthCompleteResult(toolName, output)) {
            mcpOAuthPending = false;
          }
          tools.set(toolCallId, toolRecord);
          upsertTimelineTool(timelineParts, toolRecord);

          if (isError) {
            safeWrite({
              type: "tool-output-error",
              toolCallId,
              errorText: stringifyForDisplay(output),
              dynamic: true,
            });
          } else {
            safeWrite({
              type: "tool-output-available",
              toolCallId,
              output: stringifyForDisplay(output),
              dynamic: true,
            });
          }
        }
      });

      try {
        if (aborted) {
          await persistPartialAssistant();
          return;
        }

        applySchedulingToolPolicy(session, options.userMessage);
        // See runPiAgentText: a run has to be reachable from the other surfaces
        // for the whole time it is working.
        registerActiveRun(options.chatId, { session, runId, surface: "web" });
        await session.prompt(preparePromptForRuntime(options.userMessage));

        if (aborted) {
          await abortPromise;
          await persistPartialAssistant();
          return;
        }

        currentPromptUsage = currentPromptUsage ?? subtractUsage(getSessionTokenUsage(session), baselineUsage);
        lastTurnUsage = lastTurnUsage ?? currentPromptUsage;
        if (isEmptyZeroTokenTurn(assistantText, tools.values(), currentPromptUsage)) {
          throw await emptyTurnError(providerFailure);
        }
        const finalStats = buildPiRuntimeStats(session, currentPromptUsage, addUsage(baselineUsage, currentPromptUsage));
        emitStats(finalStats);
        closeTextPart();
        await persistAssistantMessage({
          chatId: options.chatId,
          assistantText,
          tools: [...tools.values()],
          runtimeStats: finalStats,
          parts: timelineParts,
        });
        persisted = true;
      } catch (error) {
        if (aborted || options.abortSignal?.aborted) {
          aborted = true;
          await abortPromise;
          await persistPartialAssistant();
          return;
        }

        const errorStats = buildPiRuntimeStats(
          session,
          currentPromptUsage ?? lastTurnUsage,
          addUsage(baselineUsage, currentPromptUsage)
        );
        const notice = extractEggentNotice(error);
        // A provider-supplied notice is already written for the end user in their
        // language, so show that instead of the raw "Generation failed: ..." text.
        const errorText = notice
          ? [notice.title, notice.body].filter(Boolean).join("\n\n")
          : await formatPiChatError(error);
        closeTextPart();
        if (notice) {
          safeWrite({
            type: "data-eggentNotice",
            id: `eggent-notice-${crypto.randomUUID()}`,
            data: { ...notice, timestamp: new Date().toISOString() },
          });
          clearUsageSnapshotCache();
        }
        console.error("Pi chat stream execution error:", error);
        await persistAssistantMessage({
          chatId: options.chatId,
          assistantText: errorText,
          tools: [...tools.values()],
          runtimeStats: errorStats,
          parts: [...completedTimelineParts(timelineParts), { type: "text", text: errorText }],
        });
        persisted = true;
        throw error;
      } finally {
        clearActiveRun(options.chatId, runId);
        options.abortSignal?.removeEventListener("abort", handleAbort);
        unsubscribe();
        if (aborted) {
          cancelPendingInteractionsForRun(runId);
          session.dispose();
          return;
        }
        const retained = await retainPiScheduleSession({
          chatId: options.chatId,
          projectId: options.projectId,
          session,
        });
        const retainedForMcpOAuth = !retained && mcpOAuthPending
          ? retainPiMcpOAuthSession({
              chatId: options.chatId,
              projectId: options.projectId,
              session,
            })
          : false;
        if (!retained && !retainedForMcpOAuth) session.dispose();
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return message || "pi chat failed";
    },
  });
}
