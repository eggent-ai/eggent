import { DEFAULT_CHAT_TITLES } from "@/i18n/vocabulary";
import { createUIMessageStream } from "ai";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import { createEggentPiSession, rebindSessionTurn, releaseSessionTurn } from "@/lib/pi/session";
import { diagnoseCurrentProvider, getPiModelsState, managedCredentialRecoverable } from "@/lib/pi/config-store";
import { getServerTranslator } from "@/i18n/server";
import { learnFromTurn } from "@/lib/learning/review";
import { cancelPendingInteractionsForRun, listPendingInteractions } from "@/lib/pi/pending-interactions";
import { retainPiMcpOAuthSession, retainPiScheduleSession, takeRetainedPiScheduleSession } from "@/lib/pi/schedule-host";
import { clearActiveRun, getActiveRun, isStopRequest, registerActiveRun, stopActiveRun } from "@/lib/pi/active-runs";
import { createStartingRun, raceAbort, TurnAbortedError, undoFailedSetup, type TurnSetupScope } from "@/lib/pi/turn-control";
import { noteSessionEvent, startTurnWatchdog, watchdogThresholds, watchdogTickMs, type StalledTurn } from "@/lib/pi/turn-watchdog";
import { attachToLiveRun, startLiveRun, type LiveRunSink } from "@/lib/pi/live-run";
import { applySchedulingToolPolicy, hasScheduleIntent, hasScheduleManagementIntent } from "@/lib/pi/schedule-intent";
import { describeProviderFailure, type ProviderFailure } from "@/lib/pi/provider-failure";
import { isHelperToolName } from "@/lib/pi/subagent-format";
import { chatAllowsVisits, grantVisits, mentionRuntimeText, planProjectMention, revokeVisits, takeVisitFiles, type MentionPlan } from "@/lib/pi/project-visit";
import { collectProducedFiles, mergeProducedGroups, type ProducedGroup } from "@/lib/files/produced";
import { SubagentProgressTracker } from "@/lib/pi/subagent-progress";
import type { AgentProgressEvent, PiChatRunOptions, PiRuntimeStats, PiToolRecord, SubagentSnapshot } from "@/lib/pi/types";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { clearUsageSnapshotCache } from "@/lib/usage/usage-provider";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import {
  checkpointToolMessageId,
  describeInteractionForTranscript,
  spliceAssistantTurn,
} from "@/lib/pi/turn-checkpoint";

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

/**
 * The sentence a failed turn ends on, in the shape the client already expects.
 *
 * It used to come from createUIMessageStream's own onError, which only sees the
 * exception the response that started the run threw. The failure is written
 * into the run's buffer now so that everyone watching gets it; this keeps the
 * wording identical, including the fallback for an error carrying no message.
 */
function streamErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "pi chat failed";
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

/**
 * Keeps each helper's last known progress with its Agent call in the stored
 * message, so a reloaded chat still shows what every helper did and how it
 * ended. A helper still marked running when its turn is written down was cut
 * off with it, and is stored as stopped: a stored spinner would spin forever.
 */
function attachSubagentSnapshots(
  parts: ChatMessagePart[],
  tracker: SubagentProgressTracker
): ChatMessagePart[] {
  for (const part of parts) {
    if (part.type !== "tool" || !isHelperToolName(part.toolName)) continue;
    const snapshot = tracker.get(part.toolCallId);
    if (!snapshot) continue;
    if (snapshot.status === "running") {
      snapshot.status = "stopped";
      snapshot.endedAt = new Date().toISOString();
      delete snapshot.now;
    }
    part.subagent = snapshot;
  }
  return parts;
}

function subagentDataPart(snapshot: SubagentSnapshot) {
  return {
    type: "data-piSubagent" as const,
    id: `pi-subagent-${snapshot.toolCallId}`,
    data: snapshot,
  };
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
  return DEFAULT_CHAT_TITLES.includes(title.trim());
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
      "- To change a task, list with scope=\"all\", wait for the result, then call update with the exact job_id. Pass schedule to change when it runs, prompt to change what it does, or both - do not tell the user that only the timing can be changed.",
      "- To remove one task, list with scope=\"all\", then call clear with its exact job_id: only that task is removed.",
      "- For a request to remove everything scheduled, call clear with scope=\"all\" and no job_id, unless the user explicitly says current project only.",
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

/**
 * What the model is sent for this message, and what the scheduling policy reads
 * to decide which tools to withhold.
 *
 * A message that opens with @project is replaced by the rules for handing it
 * over, with the task after them; the stored message stays as the person typed
 * it. The policy reads the rules only, never the task: "@shop remind me every
 * day at 9" is work for the shop, and must not make this chat withhold its own
 * tools to schedule something.
 */
function promptForMessage(text: string, runtimeSuffix: string, mention: MentionPlan | null): { runtime: string; policy: string } {
  if (!mention) return { runtime: preparePromptForRuntime(`${text}${runtimeSuffix}`), policy: `${text}${runtimeSuffix}` };
  const runtime = mentionRuntimeText(mention, runtimeSuffix);
  if (mention.kind === "self") return { runtime: preparePromptForRuntime(runtime), policy: mention.task };
  return { runtime, policy: mention.directive };
}

/**
 * The files this turn made - what its answer names, what its tools wrote - and
 * what the projects it asked made. Never fails the turn: a card that cannot be
 * worked out is a card that is not shown.
 */
async function producedForTurn(input: {
  chatId: string;
  tools: Iterable<PiToolRecord>;
  startedAt: string;
  cwd: string;
  projectId?: string;
  assistantText: string;
}): Promise<ProducedGroup[]> {
  let own: ProducedGroup | null = null;
  try {
    own = await collectProducedFiles({
      tools: input.tools,
      startedAt: Date.parse(input.startedAt),
      cwd: input.cwd,
      projectId: input.projectId,
      assistantText: input.assistantText,
    });
  } catch (error) {
    console.warn("Could not work out the files of a turn:", error);
  }
  return mergeProducedGroups([own, ...takeVisitFiles(input.chatId)]);
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
  /** A checkpoint of this same turn to replace; see turn-checkpoint.ts. */
  replaceMessageId?: string;
  /** Set when this write is the checkpoint itself. */
  checkpointId?: string;
  /** The files the turn made, for the row under the answer. */
  files?: ProducedGroup[];
}) {
  const chat = await getChat(options.chatId);
  if (!chat) return;

  const now = new Date().toISOString();
  const completedTools = options.tools.filter((tool) => tool.status !== "running");
  const written: ChatMessage[] = [];

  if (options.assistantText.trim() || completedTools.length > 0 || options.runtimeStats) {
    const assistantId = options.checkpointId ?? crypto.randomUUID();
    written.push({
      id: assistantId,
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
      ...(options.files?.length ? { files: options.files } : {}),
      ...(options.checkpointId ? { inProgress: true } : {}),
    });

    for (const tool of completedTools) {
      written.push({
        id: options.checkpointId
          ? checkpointToolMessageId(options.checkpointId, tool.toolCallId)
          : crypto.randomUUID(),
        role: "tool",
        content: stringifyForDisplay(tool.output),
        createdAt: now,
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        toolResult: tool.output,
      });
    }
  }

  chat.messages = spliceAssistantTurn(chat.messages, options.replaceMessageId, written);
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
    // Through the run's own way of stopping, when it has one: a turn aborted
    // from outside believes it finished, and one that had written nothing yet
    // was then reported as a provider that answered nothing.
    await stopActiveRun(chatId);
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

/** What the person is told when a turn was given up on for going quiet. */
async function stalledNotice(stalled: StalledTurn): Promise<string> {
  const t = await getServerTranslator();
  const minutes = Math.max(1, Math.round(stalled.silentMs / 60_000));
  const key = stalled.phase === "starting" ? "external.run.stalledStart" : stalled.phase === "tool" ? "external.run.stalledTool" : "external.run.stalled";
  return t(key, { minutes });
}

function logStall(chatId: string, stalled: StalledTurn): void {
  console.warn(`[watchdog] chat ${chatId.slice(0, 8)} stalled in ${stalled.phase} after ${Math.round(stalled.silentMs / 1000)}s`);
}

type PiAgentTextOptions = PiChatRunOptions & {
  runtimeData?: Record<string, unknown>;
  toolRuntimeData?: Record<string, unknown>;
  /** Told about each piece of the answer as it arrives; see AgentProgressEvent. */
  onProgress?: (event: AgentProgressEvent) => void;
  /** Told about every event of the session itself, arguments and all: for code in this process, never for a caller outside it. */
  onSessionEvent?: (event: unknown) => void;
  /**
   * Filled in as the turn ends: whether somebody stopped it, which is not the
   * same as it having nothing to say, and the text of the last message the
   * model wrote - the answer, without the narration before it.
   */
  outcome?: { stopped?: boolean; finalText?: string; files?: ProducedGroup[]; filesSent?: boolean };
};

export async function runPiAgentText(options: PiAgentTextOptions): Promise<string> {
  const scope: TurnSetupScope = {};
  try {
    return await runPiAgentTextTurn(options, scope);
  } catch (error) {
    // A throw before the turn's own cleanup took over (a store that would not write, a
    // project list that would not read) must not leave the chat registered as running.
    await undoFailedSetup(scope, error);
    throw error;
  }
}

async function runPiAgentTextTurn(options: PiAgentTextOptions, scope: TurnSetupScope): Promise<string> {
  // A listener that throws must not take the turn down with it: the answer is
  // still delivered whole at the end.
  const report = (event: AgentProgressEvent) => {
    if (!options.onProgress) return;
    try {
      options.onProgress(event);
    } catch (error) {
      console.warn("A progress listener failed:", error);
    }
  };
  const turnStartedAt = new Date().toISOString();
  const userMessageId = crypto.randomUUID();
  const runId = options.runId ?? crypto.randomUUID();
  const runtimeSuffix = options.runtimeData ? `\n\nRuntime data:\n${JSON.stringify(options.runtimeData, null, 2)}` : "";
  const prompt = `${options.userMessage}${runtimeSuffix}`;

  // Reachable from the first line. A session is built by running extension
  // code, and a turn stuck there - a server that never answers - used to be
  // beyond every stop, because nothing knew it was running yet. A message that
  // arrives meanwhile is kept and handed to the turn once it can hear it.
  const runAbort = new AbortController();
  if (options.abortSignal) {
    if (options.abortSignal.aborted) runAbort.abort();
    else options.abortSignal.addEventListener("abort", () => runAbort.abort(), { once: true });
  }
  let stopped = false;
  const turn: { stalled: StalledTurn | null; session: Awaited<ReturnType<typeof createEggentPiSession>> | null } = { stalled: null, session: null };
  const requestStop = () => {
    stopped = true;
    // Not a turn to join any more, whatever its session is still doing: see markStopped.
    starting.markStopped();
    runAbort.abort();
    // A stop discards what was waiting to be added to the turn: left queued, it
    // would start the loop again the moment the abort let go of it.
    starting.takeQueuedSteers();
    turn.session?.clearQueue();
    void turn.session?.abort().catch((error) => {
      console.warn("Failed to stop the running turn:", error);
    });
  };
  const starting = createStartingRun(requestStop);
  registerActiveRun(options.chatId, { session: starting.run, runId, surface: "external", requestStop });
  const thresholds = watchdogThresholds();
  const watchdog = thresholds
    ? startTurnWatchdog({
      thresholds,
      tickMs: watchdogTickMs(),
      isWaitingForHuman: () => listPendingInteractions(runId).some((interaction) => interaction.status === "pending"),
      onSoft: () => report({ type: "silent", active: true }),
      onResume: () => report({ type: "silent", active: false }),
      onStall: (stalled) => {
        turn.stalled = stalled;
        logStall(options.chatId, stalled);
        requestStop();
      },
    })
    : null;

  // Declared here, not where it is first used: the undo below has to be able to see them.
  let live: LiveRunSink | null = null;
  const teardown: Array<() => void> = [];
  scope.abandon = async (error) => {
    watchdog?.stop();
    clearActiveRun(options.chatId, runId);
    cancelPendingInteractionsForRun(runId);
    if (live) {
      live.push({ type: "error", errorText: streamErrorText(error) });
      live.finish();
    }
    for (const undo of teardown.splice(0)) {
      try {
        undo();
      } catch {
        // Letting go of a listener must not hide the failure that came first.
      }
    }
    // A session built for this turn that nothing took over: back to where it came from, or let go.
    const built = turn.session;
    if (built) {
      const retained = await retainPiScheduleSession({ chatId: options.chatId, projectId: options.projectId, session: built });
      if (retained) releaseSessionTurn(built);
      else built.dispose();
    }
  };

  await persistUserMessage({ ...options, userMessage: prompt }, userMessageId);

  const mention = await planProjectMention(options.userMessage, {
    disabled: options.enableEggentTools === false || Boolean(options.visit) || !chatAllowsVisits(options.chatContextMode),
    currentProjectId: options.projectId,
  });
  const promptFor = promptForMessage(options.userMessage, runtimeSuffix, mention);

  let session: Awaited<ReturnType<typeof createEggentPiSession>>;
  try {
    // A session kept for its schedules is built for the turn that made them: it serves this one now.
    const lent = takeRetainedPiScheduleSession(options.chatId);
    if (lent) rebindSessionTurn(lent, { runId, abortSignal: runAbort.signal, toolRuntimeData: options.toolRuntimeData });
    session = lent ?? await raceAbort(
      createEggentPiSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        tools: options.tools,
        chatId: options.chatId,
        projectId: options.projectId,
        chatContextMode: options.chatContextMode,
        // A public share must never be handed the workspace tools; the flag was
        // accepted here and read by the learning gate below, but never reached the
        // session, so a shared chat built the full tool set.
        enableEggentTools: options.enableEggentTools,
        toolRuntimeData: options.toolRuntimeData,
        visit: options.visit,
        runId,
        abortSignal: runAbort.signal,
      }),
      runAbort.signal,
      // A session that was finally built for a turn nobody is waiting on.
      (late) => late.dispose()
    );
  } catch (error) {
    watchdog?.stop();
    clearActiveRun(options.chatId, runId);
    cancelPendingInteractionsForRun(runId);
    scope.abandon = undefined;
    if (!(error instanceof TurnAbortedError)) throw error;
    // Stopped, or given up on, before it began.
    const t = await getServerTranslator();
    const notice = turn.stalled ? await stalledNotice(turn.stalled) : t("external.run.stopped");
    await persistAssistantMessage({ chatId: options.chatId, assistantText: notice, tools: [], parts: [{ type: "text", text: notice }] });
    // Said the way a stop is said later in the turn: somebody stopped it, so the surface that
    // already told them so (the stop word's own reply) does not say it twice. A turn given up
    // on for going quiet still has its notice to deliver.
    if (options.outcome) {
      options.outcome.stopped = true;
      options.outcome.finalText = "";
    }
    return turn.stalled ? notice : "";
  }
  turn.session = session;
  starting.attach(session);

  let assistantText = "";
  let lastTurnUsage: PiRuntimeStats["lastTurn"] | undefined;
  let currentPromptUsage: PiRuntimeStats["lastTurn"] | undefined;
  let providerFailure: ProviderFailure | null = null;
  const baselineUsage = getSessionTokenUsage(session);
  const tools = new Map<string, PiToolRecord>();
  const timelineParts: ChatMessagePart[] = [];
  let mcpOAuthPending = false;
  // The web can watch a Telegram turn, so it gets each helper's progress too; a
  // messenger only needs to know how many are still working.
  let reportedHelpers = "";
  const subagents = new SubagentProgressTracker({
    sessionId: session.sessionId,
    cwd: session.sessionManager.getCwd(),
    onChange: (snapshot) => {
      live?.push(subagentDataPart(snapshot));
      const { running, total } = subagents.counts();
      const key = `${running}/${total}`;
      if (key === reportedHelpers) return;
      reportedHelpers = key;
      report({ type: "helpers", running, total });
    },
  });

  // A turn started in Telegram is the same turn as one started in the browser,
  // and the workspace's own chat window should be able to watch it happen
  // rather than wait for the finished message to appear. This path has no
  // stream of its own, so it shapes the same chunks by hand.
  let liveTextId: string | null = null;
  const liveText = (delta: string) => {
    if (!live) return;
    if (!liveTextId) {
      liveTextId = `pi-text-${crypto.randomUUID()}`;
      live.push({ type: "text-start", id: liveTextId });
    }
    live.push({ type: "text-delta", id: liveTextId, delta });
  };
  const liveCloseText = () => {
    if (!live || !liveTextId) return;
    live.push({ type: "text-end", id: liveTextId });
    liveTextId = null;
  };

  // The text of the message being written, and of the last one that was
  // finished: the answer is the last, not everything said on the way to it.
  let messageText = "";
  let lastMessageText = "";
  teardown.push(() => subagents.dispose());
  const unsubscribe = session.subscribe((event: unknown) => {
    const record = asRecord(event);
    if (!record) return;
    if (options.onSessionEvent) {
      try {
        options.onSessionEvent(record);
      } catch (error) {
        console.warn("A session event listener failed:", error);
      }
    }
    subagents.handle(record);
    if (watchdog) noteSessionEvent(watchdog, record);
    if (record.type === "message_start" && asRecord(record.message)?.role === "assistant") messageText = "";
    // Said to the turn while it was still being set up: it can hear it now.
    if (record.type === "agent_start") {
      starting.markStarted();
      if (stopped) {
        // Stopped while the session was getting ready to ask the model, when there was no agent to
        // stop yet: it stops at the first moment there is one, before a word goes to the model.
        void session.abort().catch((error) => console.warn("Failed to stop the turn as it began:", error));
      } else {
        for (const text of starting.takeQueuedSteers()) {
          void session.steer(text).catch((error) => console.warn("Failed to hand a waiting message to the turn:", error));
        }
      }
    }

    if (record.type === "message_update") {
      const assistantEvent = asRecord(record.assistantMessageEvent);
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        assistantText += assistantEvent.delta;
        messageText += assistantEvent.delta;
        appendTimelineText(timelineParts, assistantEvent.delta);
        liveText(assistantEvent.delta);
        report({ type: "text", delta: assistantEvent.delta });
      }
      return;
    }

    if (record.type === "message_end") {
      const message = asRecord(record.message);
      if (message?.role === "assistant") {
        if (messageText.trim()) lastMessageText = messageText;
        const usage = asUsage(message.usage);
        lastTurnUsage = usage ?? lastTurnUsage;
        currentPromptUsage = addUsage(currentPromptUsage, usage);
        // A refusal arrives as a message like any other, carrying the reason.
        // Keep the last one: a retried turn ends on whichever attempt stopped.
        providerFailure =
          message.stopReason === "error"
            ? describeProviderFailure(message.errorMessage) ?? providerFailure
            : null;
        live?.push({
          type: "data-piStats",
          id: "pi-runtime-stats",
          data: buildPiRuntimeStats(session, currentPromptUsage, addUsage(baselineUsage, currentPromptUsage)),
        });
      }
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
      upsertTimelineTool(timelineParts, toolRecord);
      liveCloseText();
      live?.push({ type: "tool-input-available", toolCallId, toolName, input, dynamic: true });
      report({ type: "tool", name: toolName, phase: "start" });
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
      report({ type: "tool", name: toolName, phase: "end" });
      live?.push(
        toolRecord.status === "error"
          ? { type: "tool-output-error", toolCallId, errorText: stringifyForDisplay(output), dynamic: true }
          : { type: "tool-output-available", toolCallId, output: stringifyForDisplay(output), dynamic: true }
      );
    }
  });

  teardown.push(unsubscribe);
  live = startLiveRun({
    chatId: options.chatId,
    runId,
    projectId: options.projectId ?? null,
    surface: "external",
  });

  // From here the finally below cleans up.
  scope.abandon = undefined;
  try {
    applySchedulingToolPolicy(session, promptFor.policy);
    // Reachable while it runs - and while it gets ready to - through the stand-in registered
    // at the top, which hands a steer to the session once the agent runs and reports the turn
    // as going until it has finished. Registering the session itself here lost the turn for
    // as long as the session took to start asking the model.
    // The person named a project: only now may the tool be used for it.
    if (mention) grantVisits(options.chatId, mention.allowed);
    try {
      await session.prompt(promptFor.runtime);
    } catch (error) {
      // A turn somebody stopped may end by throwing; what it wrote is kept.
      if (!stopped) throw error;
    }
    liveCloseText();
    if (turn.stalled) {
      // Given up on for going quiet: the answer says so, in the person's words.
      const notice = await stalledNotice(turn.stalled);
      const separator = assistantText.trim() ? "\n\n" : "";
      assistantText = `${assistantText}${separator}${notice}`;
      appendTimelineText(timelineParts, `${separator}${notice}`);
      liveText(`${separator}${notice}`);
      liveCloseText();
    }
    currentPromptUsage = currentPromptUsage ?? subtractUsage(getSessionTokenUsage(session), baselineUsage);
    lastTurnUsage = lastTurnUsage ?? currentPromptUsage;
    // A turn someone stopped produced nothing because they said so, which is
    // not the same fact as a provider that answered nothing.
    if (!stopped && isEmptyZeroTokenTurn(assistantText, tools.values(), currentPromptUsage)) {
      throw await emptyTurnError(providerFailure);
    }
    const producedFiles = await producedForTurn({
      chatId: options.chatId,
      tools: tools.values(),
      startedAt: turnStartedAt,
      cwd: session.sessionManager.getCwd(),
      projectId: options.projectId,
      assistantText,
    });
    if (options.outcome) {
      options.outcome.files = producedFiles;
      // The agent already sent files to the person's own chat: no need to say they can be fetched.
      options.outcome.filesSent = [...tools.values()].some(
        (tool) => tool.toolName === "telegram_send_file" && tool.status === "completed" && /"success":\s*true/.test(stringifyForDisplay(tool.output))
      );
    }
    await persistAssistantMessage({
      chatId: options.chatId,
      assistantText,
      tools: [...tools.values()],
      runtimeStats: buildPiRuntimeStats(session, currentPromptUsage, addUsage(baselineUsage, currentPromptUsage)),
      parts: attachSubagentSnapshots(timelineParts, subagents),
      files: producedFiles,
    });
    // A visit is the project doing what another chat asked: what the person
    // said was said there, and that turn does the learning from it.
    if (!stopped && !options.visit) {
      learnFromTurn({
        chatId: options.chatId,
        projectId: options.projectId,
        contextMode: options.chatContextMode,
        // The host switches the Eggent tools off for a public share.
        isPublicShare: options.enableEggentTools === false,
        userMessage: options.userMessage,
        assistantText,
        tools: tools.values(),
        model: session.model,
        startedAt: turnStartedAt,
        toolRuntimeData: options.toolRuntimeData,
      });
    }
    if (stopped && options.outcome) options.outcome.stopped = true;
    if (options.outcome) options.outcome.finalText = lastMessageText;
    return assistantText;
  } catch (error) {
    // The caller of this path answers the messenger it came from; anyone
    // watching the same turn from the web would otherwise see the stream
    // simply stop, with nothing said about why.
    liveCloseText();
    live?.push({ type: "error", errorText: streamErrorText(error) });
    throw error;
  } finally {
    if (mention) revokeVisits(options.chatId);
    takeVisitFiles(options.chatId);
    watchdog?.stop();
    live?.finish();
    clearActiveRun(options.chatId, runId);
    cancelPendingInteractionsForRun(runId);
    unsubscribe();
    subagents.dispose();
    const retained = await retainPiScheduleSession({
      chatId: options.chatId,
      projectId: options.projectId,
      session,
    });
    // Kept for its schedules, it must not go on holding this turn's stop signal and question stream.
    if (retained) releaseSessionTurn(session);
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
  const turnStartedAt = new Date().toISOString();
  const userMessageId = crypto.randomUUID();
  const runId = options.runId ?? crypto.randomUUID();

  const executeTurn = async (writer: UIMessageStreamWriter<UIMessage>, scope: TurnSetupScope): Promise<void> => {
      // Resolved up front: the runtime's compaction events arrive on a
      // synchronous listener, which cannot await a translator of its own.
      const tCompaction = await getServerTranslator();
      await persistUserMessage(options, userMessageId);

      // The turn is stopped through here and nowhere else. It used to be tied to
      // the request that started it, so closing the tab killed the work - and
      // switching to another chat left the only copy of the output going into a
      // connection nobody was reading. Stopping is now something the person
      // asks for explicitly, through the stop button or a stop word.
      const runAbort = new AbortController();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) runAbort.abort();
        else options.abortSignal.addEventListener("abort", () => runAbort.abort(), { once: true });
      }

      let aborted = runAbort.signal.aborted;
      let persisted = false;
      let abortPromise: Promise<void> | null = null;

      // Set once the run is registered; until then this response is the only
      // reader there could be.
      let live: LiveRunSink | null = null;

      const safeWrite = (part: Parameters<typeof writer.write>[0]) => {
        if (aborted) return;
        if (live) live.push(part);
        else writer.write(part);
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

      // Reachable while the session is still being built, so a stop - the
      // button, a stop word, /reset - finds a turn stuck there.
      const starting = createStartingRun(() => runAbort.abort());
      // A stop, from any source, makes the turn one that is not joined any more (see markStopped).
      if (runAbort.signal.aborted) starting.markStopped();
      else runAbort.signal.addEventListener("abort", () => starting.markStopped(), { once: true });
      registerActiveRun(options.chatId, {
        session: starting.run,
        runId,
        surface: "web",
        requestStop: () => runAbort.abort(),
      });
      const stall: { stalled: StalledTurn | null } = { stalled: null };
      const thresholds = watchdogThresholds();
      const watchdog = thresholds
        ? startTurnWatchdog({
          thresholds,
          tickMs: watchdogTickMs(),
          // A question on screen is the person's turn to speak, not a silence.
          isWaitingForHuman: () => listPendingInteractions(runId).some((interaction) => interaction.status === "pending"),
          onStall: (stalled) => {
            stall.stalled = stalled;
            logStall(options.chatId, stalled);
            runAbort.abort();
          },
        })
        : null;

      // How to undo the registration above if the turn fails before its own cleanup begins.
      let built: Awaited<ReturnType<typeof createEggentPiSession>> | null = null;
      const teardown: Array<() => void> = [];
      scope.abandon = async (error) => {
        watchdog?.stop();
        clearActiveRun(options.chatId, runId);
        cancelPendingInteractionsForRun(runId);
        if (live) {
          live.push({ type: "error", errorText: streamErrorText(error) });
          live.finish();
        }
        for (const undo of teardown.splice(0)) {
          try {
            undo();
          } catch {
            // Letting go of a listener must not hide the failure that came first.
          }
        }
        // A session built for this turn that nothing took over: back to where it came from, or let go.
        if (built) {
          const retained = await retainPiScheduleSession({ chatId: options.chatId, projectId: options.projectId, session: built });
          if (retained) releaseSessionTurn(built);
          else built.dispose();
        }
      };

      const mention = await planProjectMention(options.userMessage, {
        disabled: options.enableEggentTools === false || Boolean(options.visit) || !chatAllowsVisits(options.chatContextMode),
        currentProjectId: options.projectId,
      });
      const promptFor = promptForMessage(options.userMessage, "", mention);

      // A question the agent asks is put on this response's stream, and saved with the turn so far.
      const onPiInteraction = (interaction: PiPendingInteraction) => {
        safeWrite({
          type: "data-piInteraction",
          id: `pi-interaction-${interaction.id}`,
          data: interaction,
        });
        if (interaction.status === "pending") checkpointBeforeQuestion(interaction);
      };

      let session: Awaited<ReturnType<typeof createEggentPiSession>>;
      try {
        // A session kept for its schedules is built for the turn that made them: it serves this one now.
        const lent = takeRetainedPiScheduleSession(options.chatId);
        if (lent) rebindSessionTurn(lent, { runId, abortSignal: runAbort.signal, onPiInteraction });
        session = lent ?? await raceAbort(
          createEggentPiSession({
            cwd: options.cwd,
            agentDir: options.agentDir,
            tools: options.tools,
            chatId: options.chatId,
            projectId: options.projectId,
            chatContextMode: options.chatContextMode,
            enableEggentTools: options.enableEggentTools,
            runId,
            abortSignal: runAbort.signal,
            onPiInteraction,
          }),
          runAbort.signal,
          (late) => late.dispose()
        );
      } catch (error) {
        watchdog?.stop();
        clearActiveRun(options.chatId, runId);
        cancelPendingInteractionsForRun(runId);
        scope.abandon = undefined;
        if (!(error instanceof TurnAbortedError)) throw error;
        // Stopped, or given up on, before it began: say so, and keep it.
        const t = await getServerTranslator();
        const notice = stall.stalled ? await stalledNotice(stall.stalled) : t("external.run.stopped");
        await persistAssistantMessage({ chatId: options.chatId, assistantText: notice, tools: [], parts: [{ type: "text", text: notice }] });
        const textId = `pi-text-${crypto.randomUUID()}`;
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: notice });
        writer.write({ type: "text-end", id: textId });
        return;
      }
      built = session;
      starting.attach(session);

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
      const subagents = new SubagentProgressTracker({
        sessionId: session.sessionId,
        cwd: session.sessionManager.getCwd(),
        onChange: (snapshot) => safeWrite(subagentDataPart(snapshot)),
      });

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

      // See turn-checkpoint.ts. Writes go through one chain so a checkpoint
      // still being saved cannot land after the final message and undo it.
      let checkpointId: string | undefined;
      let persistChain: Promise<void> = Promise.resolve();
      const queuePersist = (work: () => Promise<void>) => {
        persistChain = persistChain.then(work).catch((error) => {
          console.warn("Failed to save the turn so far:", error);
        });
        return persistChain;
      };
      const persistTurn = (message: Omit<Parameters<typeof persistAssistantMessage>[0], "chatId">) =>
        queuePersist(() =>
          persistAssistantMessage({ chatId: options.chatId, replaceMessageId: checkpointId, ...message })
        );

      function checkpointBeforeQuestion(interaction: PiPendingInteraction) {
        if (persisted || aborted) return;
        checkpointId ??= crypto.randomUUID();
        const id = checkpointId;
        const question = describeInteractionForTranscript(interaction);
        // Copied now: by the time the write runs the turn may have moved on.
        // Helper snapshots are left out on purpose - attaching them marks a
        // helper that is still working as stopped.
        const text = [assistantText, question].filter((part) => part.trim()).join("\n\n");
        const parts: ChatMessagePart[] = [
          ...completedTimelineParts(timelineParts).map((part) => ({ ...part })),
          ...(question ? [{ type: "text" as const, text: question }] : []),
        ];
        const toolsSoFar = [...tools.values()];
        const stats = currentStats();
        void queuePersist(() =>
          persistAssistantMessage({
            chatId: options.chatId,
            assistantText: text,
            tools: toolsSoFar,
            runtimeStats: stats,
            parts,
            replaceMessageId: id,
            checkpointId: id,
          })
        );
      }

      const persistPartialAssistant = async (runtimeStats: PiRuntimeStats = currentStats()) => {
        if (persisted) return;
        persisted = true;
        closeTextPart();
        if (stall.stalled) {
          // Given up on for going quiet: the stored turn says so, in the person's words.
          const notice = await stalledNotice(stall.stalled);
          const separator = assistantText.trim() ? "\n\n" : "";
          assistantText = `${assistantText}${separator}${notice}`;
          appendTimelineText(timelineParts, `${separator}${notice}`);
        }
        // A stopped turn keeps the files it had made, as the same turn on the other surface does.
        const files = await producedForTurn({
          chatId: options.chatId,
          tools: tools.values(),
          startedAt: turnStartedAt,
          cwd: session.sessionManager.getCwd(),
          projectId: options.projectId,
          assistantText,
        });
        await persistTurn({
          assistantText,
          tools: [...tools.values()],
          runtimeStats,
          parts: completedTimelineParts(attachSubagentSnapshots(timelineParts, subagents)),
          ...(files.length > 0 ? { files } : {}),
        });
      };

      const abortSession = () => {
        if (aborted && abortPromise) return abortPromise;
        aborted = true;
        cancelPendingInteractionsForRun(runId);
        abortPromise = (async () => {
          try {
            session.clearQueue();
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

      runAbort.signal.addEventListener("abort", handleAbort, { once: true });
      teardown.push(() => runAbort.signal.removeEventListener("abort", handleAbort), () => subagents.dispose());
      // A stop that came while the turn was getting set up - reading the projects of an @ message,
      // say - fired before this listener existed, and a session lent from its schedules has no
      // build to race it against: without this the stop is acknowledged and never acted on.
      if (runAbort.signal.aborted) handleAbort();

      const unsubscribe = session.subscribe((event: unknown) => {
        const record = asRecord(event);
        if (!record) return;
        subagents.handle(record);
        if (watchdog) noteSessionEvent(watchdog, record);
        if (record.type === "agent_start") {
          starting.markStarted();
          if (aborted) {
            // Stopped while the session was getting ready to ask the model, when there was no
            // agent to stop yet: it stops at the first moment there is one, before a word goes out.
            void session.abort().catch((error) => console.warn("Failed to stop the turn as it began:", error));
          } else {
            for (const text of starting.takeQueuedSteers()) {
              void session.steer(text).catch((error) => console.warn("Failed to hand a waiting message to the turn:", error));
            }
          }
        }

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
              message: reason === "manual" ? tCompaction("chat.compaction.runningManual") : tCompaction("chat.compaction.runningAuto"),
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
                ? tCompaction("chat.compaction.done", { before: beforeText, after: afterText })
                : errorMessage
                  ? tCompaction("chat.compaction.failedWithReason", { details: errorMessage })
                  : tCompaction("chat.compaction.failed"),
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

      // From here the run owns a buffer rather than a connection, and this
      // response is simply the first thing reading it. A second tab, or the same
      // tab coming back to the chat, attaches to the same buffer and sees the
      // turn from the beginning.
      teardown.push(unsubscribe);
      live = startLiveRun({
        chatId: options.chatId,
        runId,
        projectId: options.projectId ?? null,
        surface: "web",
      });
      attachToLiveRun(options.chatId, {
        onChunk: (chunk) => writer.write(chunk),
        onFinish: () => {},
      });

      emitStats(buildPiRuntimeStats(session));

      // From here the finally below cleans up.
      scope.abandon = undefined;
      try {
        if (aborted) {
          await persistPartialAssistant();
          return;
        }

        applySchedulingToolPolicy(session, promptFor.policy);
        // See runPiAgentText: the stand-in registered at the top keeps this run reachable from
        // the other surfaces for the whole time it is working, so the session is not registered
        // again here.
        // The person named a project: only now may the tool be used for it.
        if (mention) grantVisits(options.chatId, mention.allowed);
        await session.prompt(promptFor.runtime);

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
        const producedFiles = await producedForTurn({
          chatId: options.chatId,
          tools: tools.values(),
          startedAt: turnStartedAt,
          cwd: session.sessionManager.getCwd(),
          projectId: options.projectId,
          assistantText,
        });
        // Shown at once; the stored message carries the same list for a reload.
        if (producedFiles.length > 0) safeWrite({ type: "data-eggentFiles", id: "eggent-files", data: producedFiles });
        persisted = true;
        await persistTurn({
          assistantText,
          tools: [...tools.values()],
          runtimeStats: finalStats,
          parts: attachSubagentSnapshots(timelineParts, subagents),
          files: producedFiles,
        });
        learnFromTurn({
          chatId: options.chatId,
          projectId: options.projectId,
          contextMode: options.chatContextMode,
          userMessage: options.userMessage,
          assistantText,
          tools: tools.values(),
          model: session.model,
          startedAt: turnStartedAt,
        });
      } catch (error) {
        if (aborted || runAbort.signal.aborted) {
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
        persisted = true;
        await persistTurn({
          assistantText: errorText,
          tools: [...tools.values()],
          runtimeStats: errorStats,
          parts: [...completedTimelineParts(attachSubagentSnapshots(timelineParts, subagents)), { type: "text", text: errorText }],
        });
        // Written into the buffer rather than rethrown: an exception out of
        // execute reaches only the response that started the run, and everyone
        // else watching would be left with a stream that simply stopped.
        safeWrite({ type: "error", errorText: streamErrorText(error) });
      } finally {
        if (mention) revokeVisits(options.chatId);
        takeVisitFiles(options.chatId);
        watchdog?.stop();
        live?.finish();
        clearActiveRun(options.chatId, runId);
        runAbort.signal.removeEventListener("abort", handleAbort);
        unsubscribe();
        subagents.dispose();
        if (aborted) {
          cancelPendingInteractionsForRun(runId);
          await abortPromise;
        }
        // A stopped turn still goes through retention: the chat's schedules
        // live in this session too, and disposing it here ended every one of
        // them until the next restart.
        const retained = await retainPiScheduleSession({
          chatId: options.chatId,
          projectId: options.projectId,
          session,
        });
        // Kept for its schedules, it must not go on holding this turn's stop signal and question stream.
        if (retained) releaseSessionTurn(session);
        const retainedForMcpOAuth = !retained && !aborted && mcpOAuthPending
          ? retainPiMcpOAuthSession({
              chatId: options.chatId,
              projectId: options.projectId,
              session,
            })
          : false;
        if (!retained && !retainedForMcpOAuth) session.dispose();
      }
  };

  return createUIMessageStream<UIMessage>({
    async execute({ writer }) {
      const scope: TurnSetupScope = {};
      try {
        await executeTurn(writer, scope);
      } catch (error) {
        // See runPiAgentText: a throw before the turn's own cleanup took over.
        await undoFailedSetup(scope, error);
        throw error;
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return message || "pi chat failed";
    },
  });
}
