import { DEFAULT_CHAT_TITLES } from "@/i18n/vocabulary";
import { createUIMessageStream } from "ai";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import { createEggentPiSession, rebindSessionTurn, releaseSessionTurn } from "@/lib/pi/session";
import { diagnoseCurrentProvider, getPiModelsState, managedCredentialRecoverable } from "@/lib/pi/config-store";
import { getServerTranslator } from "@/i18n/server";
import { learnFromTurn } from "@/lib/learning/review";
import { cancelPendingInteractionsForRun, listPendingInteractions } from "@/lib/pi/pending-interactions";
import { retainPiMcpOAuthSession, retainPiScheduleSession, takeRetainedPiScheduleSession } from "@/lib/pi/schedule-host";
import { clearActiveRun, joinActiveRun, registerActiveRun } from "@/lib/pi/active-runs";
import { createStartingRun, raceAbort, TurnAbortedError, undoFailedSetup, type TurnSetupScope } from "@/lib/pi/turn-control";
import { noteSessionEvent, startTurnWatchdog, UNANSWERED_QUESTION, watchdogThresholds, watchdogTickMs, type StalledTurn } from "@/lib/pi/turn-watchdog";
import { attachToLiveRun, startLiveRun, type LiveRunSink } from "@/lib/pi/live-run";
import { applySchedulingToolPolicy, hasScheduleIntent, hasScheduleManagementIntent } from "@/lib/pi/schedule-intent";
import { describeProviderFailure, type ProviderFailure } from "@/lib/pi/provider-failure";
import { isGatewayRefusal } from "@/lib/pi/gateway-refusal";
import { trackCardTurn, type CardTurn } from "@/lib/board/runs";
import type { CardQuestion } from "@/lib/board/types";
import { isHelperToolName } from "@/lib/pi/subagent-format";
import { chatAllowsVisits, grantVisits, mentionRuntimeText, planProjectMention, revokeVisits, takeVisitFiles, type MentionPlan } from "@/lib/pi/project-visit";
import { resolveEngineRun } from "@/lib/engines/resolve";
import { isEngineProviderId } from "@/lib/engines/types";
import { collectProducedFiles, mergeProducedGroups, type ProducedGroup } from "@/lib/files/produced";
import { SubagentProgressTracker } from "@/lib/pi/subagent-progress";
import type { AgentProgressEvent, PiChatRunOptions, PiRuntimeStats, PiToolRecord, SubagentSnapshot } from "@/lib/pi/types";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { clearUsageSnapshotCache } from "@/lib/usage/usage-provider";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";
import type { ChatHome } from "@/lib/remote/types";
import { runHandedOverText, storedRemoteHome } from "@/lib/remote/proxy-turn";
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

/** The text of a message's content parts, whatever dialect wrote them. */
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

/** A question put on a board card instead of to a person nobody could reach: see eggent_ask_user. */
function isQuestionOnCard(toolName: string, output: unknown): boolean {
  return toolName === "eggent_ask_user" && asRecord(asRecord(output)?.details)?.onCard === true;
}

/** The question the ask tool was given, in the card's shape. */
function cardQuestionFrom(input: unknown): Omit<CardQuestion, "askedAt"> | null {
  const args = asRecord(input);
  const text = typeof args?.question === "string" ? args.question.trim() : "";
  if (!text) return null;
  const options = Array.isArray(args?.options) ? args.options.filter((option): option is string => typeof option === "string" && Boolean(option.trim())).slice(0, 6) : [];
  const kind = args?.kind === "confirm" ? "confirm" : args?.kind === "free_text" ? "free_text" : options.length >= 2 ? "choice" : "free_text";
  return {
    text,
    kind,
    ...(options.length ? { options } : {}),
    ...(typeof args?.placeholder === "string" && args.placeholder.trim() ? { placeholder: args.placeholder.trim() } : {}),
  };
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
  // The stand-in model of an engine counts nothing, and a row of zeros under
  // the composer would read as a program that cost nothing to run rather than
  // one whose cost is not ours to show.
  if (isEngineProviderId(session.model?.provider)) {
    return {
      model: { provider: session.model?.provider, id: session.model?.id, name: session.model?.name },
      engine: true,
    };
  }
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
    const name = provider ? state.providers?.find((item) => item.id === provider)?.name || provider : t("chat.errors.theProvider");

    // The provider's own words outrank everything below, the settings included.
    // Settings checks and the probe exist to work out what went wrong when
    // nothing said; when something did say, guessing over it is how "your key
    // may be wrong" got shown to a user whose key was fine and whose service
    // account had been disabled, and "no model is selected" to one whose
    // provider had refused a request it was plainly sent.
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
    if (!provider) {
      return await withFallback(t("chat.errors.noModelSelected"));
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

/** How the last model call of a turn ended. */
interface LastCall {
  stopReason?: unknown;
  errorMessage?: unknown;
  /** What that call wrote, which may be nothing even when earlier calls wrote plenty. */
  text: string;
}

function lastCallOf(message: Record<string, unknown>, text: string): LastCall {
  return { stopReason: message.stopReason, errorMessage: message.errorMessage, text };
}

/**
 * The error a turn ended on after it had already done some work, worded for the
 * person; null when it did not end on one.
 *
 * A turn that fails before doing anything is caught as an empty turn. One that
 * fails after a few tool calls was stored as a success with no text: the person
 * saw an empty answer while the provider's own sentence ("the key's budget is
 * spent") sat in the agent's session where nobody reads it.
 */
async function failureAfterWork(last: LastCall, failure: ProviderFailure | null): Promise<string | null> {
  if (last.stopReason !== "error") return null;
  const said = failure ?? describeProviderFailure(last.errorMessage);
  if (said) return (await emptyTurnError(said)).message;
  const t = await getServerTranslator();
  return t("chat.errors.turnFailed");
}

/**
 * True when the model's last call finished normally and wrote nothing, after a
 * turn that did something: what the person sees is the narration before the
 * work, or an empty bubble. Reasoning models do this - they think the answer
 * through and stop without writing it.
 */
function endedWithoutAnswer(last: LastCall | null, tools: Iterable<PiToolRecord>, usage?: PiRuntimeStats["lastTurn"]): boolean {
  if (!last || last.stopReason !== "stop" || last.text.trim()) return false;
  for (const tool of tools) {
    // The answer already went to the person's chat as a message of its own.
    if (/^telegram_send_/.test(tool.toolName) && tool.status === "completed") return false;
  }
  for (const tool of tools) {
    if (tool.status === "completed" || tool.status === "error") return true;
  }
  return (usage?.output ?? 0) > 0;
}

/** Sent once, unseen by the person, when a turn ends without an answer. */
const ANSWER_NUDGE =
  "[Eggent] The turn ended without a reply: the person sees nothing from you. Write the reply now - what came out, " +
  "where any files are, and what is left to do if anything. Do not call tools again unless something essential is missing.";

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
  // A word like "tomorrow" is how a reminder is asked for, and just as often
  // part of what is to be said or done now: "tell Ann the meeting is tomorrow
  // at 10" was scheduled for tomorrow at 10 when the directive said outright
  // that the request asked for later execution. The model reads which it is.
  return [
    "Eggent scheduling directive:",
    "- This request mentions a time. If the user wants something done later or repeatedly, schedule it as below. If the time is only part of what to do or say now - a message to send, a date in a text - do it now and schedule nothing.",
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
/**
 * What the model is sent for the person's message, and what the turn's rules
 * read (`policy`). `note` - the file open beside the chat - goes to the model
 * only: a selected paragraph that mentions "every morning" is not a request
 * for a schedule. A message for another project carries none: the open file is
 * this chat's, not the project's.
 */
function promptForMessage(text: string, runtimeSuffix: string, mention: MentionPlan | null, note = ""): { runtime: string; policy: string } {
  const tail = note ? `\n\n${note}` : "";
  if (!mention) return { runtime: `${preparePromptForRuntime(`${text}${runtimeSuffix}`)}${tail}`, policy: `${text}${runtimeSuffix}` };
  const runtime = mentionRuntimeText(mention, runtimeSuffix);
  if (mention.kind === "self") return { runtime: `${preparePromptForRuntime(runtime)}${tail}`, policy: mention.task };
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

/** How often a running turn's progress is written to the stored chat; see checkpointProgress. */
const CHECKPOINT_EVERY_MS = Number(process.env.EGGENT_TURN_CHECKPOINT_MS) || 10_000;

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

// Moved to active-runs.ts so a handed-over turn can use it without loading the whole runner.
export { joinActiveRun };

/** What the person is told when a turn was given up on for going quiet, or for a question nobody answered. */
async function stalledNotice(stalled: StalledTurn): Promise<string> {
  const t = await getServerTranslator();
  if (stalled.unanswered) {
    // A day unless a deployment chose otherwise, and a short limit is said in minutes.
    return stalled.silentMs < 3_600_000
      ? t("external.run.stalledQuestionMinutes", { minutes: Math.max(1, Math.round(stalled.silentMs / 60_000)) })
      : t("external.run.stalledQuestion", { hours: Math.round(stalled.silentMs / 3_600_000) });
  }
  const minutes = Math.max(1, Math.round(stalled.silentMs / 60_000));
  const key = stalled.phase === "starting" ? "external.run.stalledStart" : stalled.phase === "tool" ? "external.run.stalledTool" : "external.run.stalled";
  return t(key, { minutes });
}

function logStall(chatId: string, stalled: StalledTurn): void {
  if (stalled.unanswered) {
    console.warn(`[watchdog] chat ${chatId.slice(0, 8)} stopped: a question waited ${Math.round(stalled.silentMs / 60_000)} min with no answer`);
    return;
  }
  console.warn(`[watchdog] chat ${chatId.slice(0, 8)} stalled in ${stalled.phase} after ${Math.round(stalled.silentMs / 1000)}s`);
}

/** The question still open in a run - the one that went unanswered, when the turn is stopped for it. */
function openQuestionOf(runId: string): PiPendingInteraction | null {
  return listPendingInteractions(runId).find((interaction) => interaction.status === "pending") ?? null;
}

/**
 * The words a turn stopped by the watchdog ends with: why it stopped, after the
 * question it was waiting on when that was the reason. The stored chat kept the
 * question only while the turn waited; the finished turn replaces that, and
 * somebody who comes back a day later has to see what they were asked.
 */
async function stallEnding(stalled: StalledTurn, question: PiPendingInteraction | null): Promise<string> {
  const notice = await stalledNotice(stalled);
  const asked = stalled.unanswered && question ? describeInteractionForTranscript(question) : "";
  return [asked, notice].filter((part) => part.trim()).join("\n\n");
}

/** A question a person answers in words, as a card holds it; null for a secret, a sign-in or a command's input. */
function cardQuestionOfInteraction(interaction: PiPendingInteraction): Omit<CardQuestion, "askedAt"> | null {
  const kind = interaction.kind === "select" ? "choice" : interaction.kind === "confirm" ? "confirm" : interaction.kind === "text" ? "free_text" : null;
  // The question tool keeps the question in the message when it gave the card a title of its own.
  const text = interaction.message?.trim() || interaction.title?.trim() || "";
  if (!kind || !text) return null;
  const options = (interaction.options ?? []).map((option) => option.trim()).filter(Boolean).slice(0, 6);
  return {
    text,
    kind,
    ...(options.length ? { options } : {}),
    ...(interaction.placeholder?.trim() ? { placeholder: interaction.placeholder.trim() } : {}),
  };
}

/**
 * How a card's turn that was given up on ends on the card. A question nobody answered goes on
 * the card, as a question from a run nobody watched does, so it can be answered from the board
 * and the answer starts the card's next run; anything else waits as stalled.
 */
function stalledCardEnd(stalled: StalledTurn, question: PiPendingInteraction | null): Parameters<CardTurn["end"]>[0] {
  const onCard = stalled.unanswered && question ? cardQuestionOfInteraction(question) : null;
  return onCard ? { outcome: "question", question: onCard } : { outcome: "stalled" };
}

export type PiAgentTextOptions = PiChatRunOptions & {
  /**
   * The chat may live on the other side of a paired workspace and computer; when
   * it does, the turn is handed there instead of run here. Set by the messenger
   * handlers and by nobody else - a scheduled run, a project visit, a public
   * link and the learning pass all run where they are.
   */
  allowHandover?: boolean;
  /**
   * The task board started this turn on one of its cards and reads how it ended
   * itself; see lib/board. Any other turn in a card's chat - somebody writing
   * there from a messenger - is followed by the card on its own.
   */
  boardRun?: boolean;
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
  outcome?: {
    stopped?: boolean;
    /** Given up on by the watchdog for going quiet, which is a stop nobody asked for. */
    stalled?: boolean;
    /** The deployment's gateway answered in place of the model: a limit reached, the workspace closed. */
    refused?: boolean;
    /** What the gateway said when it refused, in its own words. */
    refusalText?: string;
    finalText?: string;
    files?: ProducedGroup[];
    filesSent?: boolean;
    /**
     * Set when the turn ran on the other side: how many messages the chat held
     * there before it, which is where what it wrote begins - this side's copy of
     * the chat may be behind by more than the turn.
     */
    chatBefore?: number;
    /** The question the turn put on its board card and stopped at, nobody being there to answer it. */
    question?: Omit<CardQuestion, "askedAt">;
  };
};

async function handOverText(options: PiAgentTextOptions, home: ChatHome): Promise<string> {
  // The text the person wrote, and the context the messenger adds to it. The
  // other side's agent reads exactly what this side's would have.
  const runtimeSuffix = options.runtimeData ? `\n\nRuntime data:\n${JSON.stringify(options.runtimeData, null, 2)}` : "";
  const chat = await getChat(options.chatId);
  // Nobody watches it over there, so over there nobody follows it on its card: this side does,
  // from the stream. The board's own runs it reads itself.
  const cardTurn: CardTurn | null = options.boardRun ? null : trackCardTurn(options.chatId, options.runId ?? crypto.randomUUID(), "external", home);
  // The other side runs the turn and keeps nothing of the board's: a question it put on the card is
  // seen here, in its stream - what was asked, and that the run stopped at it.
  const asked = new Map<string, unknown>();
  let question: Omit<CardQuestion, "askedAt"> | null = null;
  const observe = (part: Record<string, unknown>) => {
    if (part.type === "tool-input-available" && part.toolName === "eggent_ask_user" && typeof part.toolCallId === "string") {
      asked.set(part.toolCallId, part.input);
    } else if (part.type === "tool-output-available" && typeof part.toolCallId === "string" && asked.has(part.toolCallId)) {
      if (/"onCard"\s*:\s*true/.test(String(part.output ?? ""))) question = cardQuestionFrom(asked.get(part.toolCallId)) ?? question;
    }
  };
  let result: Awaited<ReturnType<typeof runHandedOverText>>;
  try {
    result = await runHandedOverText(
      {
        chatId: options.chatId,
        home,
        message: `${options.userMessage}${runtimeSuffix}`,
        projectId: options.projectId,
        contextMode: options.chatContextMode,
        currentPath: options.cwd,
        chatTitle: chat?.title,
      },
      (event) => {
        if (!options.onProgress) return;
        try {
          options.onProgress(event);
        } catch (error) {
          console.warn("A progress listener failed:", error);
        }
      },
      observe
    );
  } catch (error) {
    cardTurn?.end({ outcome: "failed", detail: streamErrorText(error) });
    throw error;
  }
  cardTurn?.end(
    question
      ? { outcome: "question", question }
      : result.stopped
        ? { outcome: "stopped" }
        : { outcome: "done", finalText: result.finalText }
  );
  if (options.outcome) {
    if (result.stopped) options.outcome.stopped = true;
    options.outcome.finalText = result.finalText;
    if (result.chatBefore !== null) options.outcome.chatBefore = result.chatBefore;
    if (question) options.outcome.question = question;
  }
  return result.text;
}

export async function runPiAgentText(options: PiAgentTextOptions): Promise<string> {
  if (options.allowHandover && !options.visit && !options.publicShare) {
    const home = await storedRemoteHome(options.chatId);
    if (home) return handOverText(options, home);
  }
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
  const turn: {
    stalled: StalledTurn | null;
    /** The question that went unanswered, when that is why the turn stopped. */
    question: PiPendingInteraction | null;
    session: Awaited<ReturnType<typeof createEggentPiSession>> | null;
  } = { stalled: null, question: null, session: null };
  const requestStop = (reason?: unknown) => {
    stopped = true;
    // Not a turn to join any more, whatever its session is still doing: see markStopped.
    starting.markStopped();
    runAbort.abort(reason);
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
  // A chat that is a board card: the card follows this turn. The board's own runs it reads itself.
  const cardTurn: CardTurn | null = options.boardRun || options.visit || options.publicShare
    ? null
    : trackCardTurn(options.chatId, runId, "external");
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
        // Read before the stop, which cancels it.
        if (stalled.unanswered) turn.question = openQuestionOf(runId);
        logStall(options.chatId, stalled);
        requestStop(stalled.unanswered ? UNANSWERED_QUESTION : undefined);
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
    cardTurn?.end({ outcome: "failed", detail: streamErrorText(error) });
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

  // A project on an engine hands the person's words to a program that has none of Eggent's tools,
  // so nothing is added to them that those tools would read.
  const onEngine = !options.publicShare && (await resolveEngineRun(options.projectId)) !== null;
  const mention = await planProjectMention(options.userMessage, {
    disabled: options.enableEggentTools === false || Boolean(options.visit) || !chatAllowsVisits(options.chatContextMode) || onEngine,
    currentProjectId: options.projectId,
  });
  const promptFor = promptForMessage(options.userMessage, onEngine ? "" : runtimeSuffix, mention);

  let session: Awaited<ReturnType<typeof createEggentPiSession>>;
  try {
    // A session kept for its schedules is built for the turn that made them: it serves this one now.
    // Never for a public share, whose session is built narrower than any the workspace keeps.
    const lent = options.publicShare ? null : takeRetainedPiScheduleSession(options.chatId);
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
        publicShare: options.publicShare,
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
    if (!(error instanceof TurnAbortedError)) {
      cardTurn?.end({ outcome: "failed", detail: streamErrorText(error) });
      throw error;
    }
    cardTurn?.end(turn.stalled ? stalledCardEnd(turn.stalled, turn.question) : { outcome: "stopped" });
    if (options.outcome && turn.stalled) options.outcome.stalled = true;
    // Stopped, or given up on, before it began.
    const t = await getServerTranslator();
    const notice = turn.stalled ? await stallEnding(turn.stalled, turn.question) : t("external.run.stopped");
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
  let lastCall: LastCall | null = null;
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
  // Whether the last model call was answered by the gateway instead of the model, and what it said.
  let refusal: string | null = null;
  // A question this turn put on its board card, because nobody here could answer it.
  let questionOnCard = false;
  let cardQuestion: Omit<CardQuestion, "askedAt"> | null = null;
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
        // The last call decides: a retry that went through is not a refusal.
        refusal = isGatewayRefusal(message) ? textOfContent(message.content).trim() || messageText.trim() : null;
        const usage = asUsage(message.usage);
        lastTurnUsage = usage ?? lastTurnUsage;
        currentPromptUsage = addUsage(currentPromptUsage, usage);
        // A refusal arrives as a message like any other, carrying the reason.
        // Keep the last one: a retried turn ends on whichever attempt stopped.
        providerFailure =
          message.stopReason === "error"
            ? describeProviderFailure(message.errorMessage) ?? providerFailure
            : null;
        lastCall = lastCallOf(message, messageText);
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
      if (!record.isError && isQuestionOnCard(toolName, output)) {
        questionOnCard = true;
        cardQuestion = cardQuestionFrom(existing?.input) ?? cardQuestion;
        // Nobody here can answer it, and the card waits for the person: the run ends at the question.
        requestStop();
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
      // Given up on for going quiet, or for a question nobody answered: the answer says so, in the person's words.
      const notice = await stallEnding(turn.stalled, turn.question);
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
    // See the web runner: no answer after the work is asked for once, and a
    // provider's refusal after the work is said, not stored as success.
    let failedAfterWork: string | null = null;
    if (!stopped && !turn.stalled) {
      const appendLine = (line: string) => {
        const separator = assistantText.trim() ? "\n\n" : "";
        assistantText = `${assistantText}${separator}${line}`;
        appendTimelineText(timelineParts, `${separator}${line}`);
        liveText(`${separator}${line}`);
        liveCloseText();
      };
      if (endedWithoutAnswer(lastCall, tools.values(), currentPromptUsage)) {
        try {
          await session.prompt(ANSWER_NUDGE);
        } catch (error) {
          if (!stopped) throw error;
        }
        liveCloseText();
        currentPromptUsage = subtractUsage(getSessionTokenUsage(session), baselineUsage);
        if (!stopped && endedWithoutAnswer(lastCall, tools.values(), currentPromptUsage)) {
          appendLine((await getServerTranslator())("chat.errors.noFinalAfterTools"));
        }
      }
      if (!stopped) {
        failedAfterWork = await failureAfterWork(lastCall ?? { text: "" }, providerFailure);
        if (failedAfterWork) appendLine(failedAfterWork);
      }
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
    if (options.outcome) {
      options.outcome.finalText = lastMessageText;
      if (turn.stalled) options.outcome.stalled = true;
      if (refusal !== null) {
        options.outcome.refused = true;
        if (refusal) options.outcome.refusalText = refusal;
      }
      if (cardQuestion) options.outcome.question = cardQuestion;
    }
    cardTurn?.end(
      questionOnCard
        ? { outcome: "question", ...(cardQuestion ? { question: cardQuestion } : {}) }
        : refusal !== null
          ? { outcome: "refused", ...(refusal ? { detail: refusal } : {}) }
          : failedAfterWork
            ? { outcome: "failed", detail: failedAfterWork }
            : turn.stalled
            ? stalledCardEnd(turn.stalled, turn.question)
            : stopped
              ? { outcome: "stopped" }
              : { outcome: "done", finalText: lastMessageText || assistantText, files: producedFiles }
    );
    return assistantText;
  } catch (error) {
    cardTurn?.end({ outcome: "failed", detail: streamErrorText(error) });
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
        ...(options.remote ? { servedForRemote: true } : {}),
      });
      // A chat that is a board card: the card follows this turn too, written by the side that runs it.
      // A turn handed here with nobody watching - a board run, a messenger's - is the one exception:
      // the side that handed it over reads how it ends from the stream and writes the card itself.
      const cardTurn: CardTurn | null = options.interactive === false ? null : trackCardTurn(options.chatId, runId, "web");
      const stall: { stalled: StalledTurn | null; question: PiPendingInteraction | null } = { stalled: null, question: null };
      const thresholds = watchdogThresholds();
      const watchdog = thresholds
        ? startTurnWatchdog({
          thresholds,
          tickMs: watchdogTickMs(),
          // A question on screen is the person's turn to speak, not a silence.
          isWaitingForHuman: () => listPendingInteractions(runId).some((interaction) => interaction.status === "pending"),
          onStall: (stalled) => {
            stall.stalled = stalled;
            // Read before the abort, which cancels it.
            if (stalled.unanswered) stall.question = openQuestionOf(runId);
            logStall(options.chatId, stalled);
            runAbort.abort(stalled.unanswered ? UNANSWERED_QUESTION : undefined);
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
        cardTurn?.end({ outcome: "failed", detail: streamErrorText(error) });
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

      const onEngine = (await resolveEngineRun(options.projectId)) !== null;
      const mention = await planProjectMention(options.userMessage, {
        disabled: options.enableEggentTools === false || Boolean(options.visit) || !chatAllowsVisits(options.chatContextMode) || onEngine,
        currentProjectId: options.projectId,
      });
      const promptFor = promptForMessage(options.userMessage, "", mention, options.openFileNote);

      // A question the agent asks is put on this response's stream, and saved with the turn so far.
      // A turn nobody is watching - a messenger handed it over - has no one to put one to.
      const onPiInteraction = options.interactive === false ? undefined : (interaction: PiPendingInteraction) => {
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
            remote: options.remote,
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
        if (!(error instanceof TurnAbortedError)) {
          cardTurn?.end({ outcome: "failed", detail: streamErrorText(error) });
          throw error;
        }
        cardTurn?.end(stall.stalled ? stalledCardEnd(stall.stalled, stall.question) : { outcome: "stopped" });
        // Stopped, or given up on, before it began: say so, and keep it.
        const t = await getServerTranslator();
        const notice = stall.stalled ? await stallEnding(stall.stalled, stall.question) : t("external.run.stopped");
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
      // The message being written and the last one finished, for a board card's result:
      // the answer, not the narration on the way to it.
      let messageText = "";
      let lastMessageText = "";
      // Whether the last model call was answered by the gateway instead of the model.
      let refusal: string | null = null;
      // How the turn ended, for a board card: set where it fails, read where it ends.
      let turnFailure: string | null = null;
      // A question this turn put on its board card: nobody watching could answer it, so the turn ends there.
      let webCardQuestion: Omit<CardQuestion, "askedAt"> | null | undefined;
      let turnFiles: ProducedGroup[] | undefined;
      let textStarted = false;
      let currentTextId: string | null = null;
      let lastTurnUsage: PiRuntimeStats["lastTurn"] | undefined;
      let currentPromptUsage: PiRuntimeStats["lastTurn"] | undefined;
      let providerFailure: ProviderFailure | null = null;
      let lastCall: LastCall | null = null;
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

      // Progress is written down as the turn goes, not only at a question:
      // a turn killed mid-command (a container recreated under it) used to
      // leave the chat at its last question, already answered, with eleven
      // minutes of work after it visible nowhere but the pi session. At most
      // one write per CHECKPOINT_EVERY_MS, the last step always covered.
      let lastCheckpointAt = 0;
      let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelProgressCheckpoint = () => {
        if (checkpointTimer) clearTimeout(checkpointTimer);
        checkpointTimer = null;
      };
      function checkpointProgress() {
        if (persisted || aborted || checkpointTimer) return;
        const wait = lastCheckpointAt + CHECKPOINT_EVERY_MS - Date.now();
        if (wait <= 0) {
          checkpointTurn();
          return;
        }
        checkpointTimer = setTimeout(() => {
          checkpointTimer = null;
          checkpointTurn();
        }, wait);
        checkpointTimer.unref?.();
      }

      function checkpointBeforeQuestion(interaction: PiPendingInteraction) {
        cancelProgressCheckpoint();
        checkpointTurn(interaction);
      }

      function checkpointTurn(interaction?: PiPendingInteraction) {
        if (persisted || aborted) return;
        lastCheckpointAt = Date.now();
        checkpointId ??= crypto.randomUUID();
        const id = checkpointId;
        const question = interaction ? describeInteractionForTranscript(interaction) : "";
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

      // A line of our own at the end of the answer, in the stored turn and on the stream alike.
      const appendNotice = (notice: string) => {
        const separator = assistantText.trim() ? "\n\n" : "";
        assistantText = `${assistantText}${separator}${notice}`;
        appendTimelineText(timelineParts, `${separator}${notice}`);
        // On the stream too, not only in the stored turn: whoever reads the
        // stream - a messenger on the other side of a handover is the case - is
        // told why the turn stopped, in the same words the stored chat has.
        // Not through safeWrite: that goes quiet once the turn is aborted, and a turn
        // that has been stopped is exactly this one.
        const noticeId = `pi-text-${crypto.randomUUID()}`;
        for (const part of [
          { type: "text-start" as const, id: noticeId },
          { type: "text-delta" as const, id: noticeId, delta: `${separator}${notice}` },
          { type: "text-end" as const, id: noticeId },
        ]) {
          try {
            if (live) live.push(part);
            else writer.write(part);
          } catch {
            // the reader is gone; the stored turn has it
          }
        }
      };

      const persistPartialAssistant = async (runtimeStats: PiRuntimeStats = currentStats()) => {
        if (persisted) return;
        persisted = true;
        cancelProgressCheckpoint();
        closeTextPart();
        if (stall.stalled) {
          // Given up on for going quiet, or for a question nobody answered: the stored turn says so, in the person's words.
          appendNotice(await stallEnding(stall.stalled, stall.question));
        } else if (webCardQuestion === undefined) {
          // Stopped. It used to be stored as whatever had been written so far,
          // which after a few silent tool calls is nothing: an empty bubble
          // under the person's message, read as the agent having failed. A turn
          // that stopped at a question for its board card is not this - the
          // question is the card's.
          appendNotice(tCompaction("external.run.stopped"));
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

        if (record.type === "message_start" && asRecord(record.message)?.role === "assistant") messageText = "";

        if (record.type === "message_update") {
          const assistantEvent = asRecord(record.assistantMessageEvent);
          if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
            const textId = ensureTextStarted();
            messageText += assistantEvent.delta;
            assistantText += assistantEvent.delta;
            appendTimelineText(timelineParts, assistantEvent.delta);
            safeWrite({ type: "text-delta", id: textId, delta: assistantEvent.delta });
          }
          return;
        }

        if (record.type === "message_end") {
          const message = asRecord(record.message);
          if (message?.role === "assistant") {
            if (messageText.trim()) lastMessageText = messageText;
            refusal = isGatewayRefusal(message) ? textOfContent(message.content).trim() || messageText.trim() : null;
            const usage = asUsage(message.usage);
            lastTurnUsage = usage ?? lastTurnUsage;
            currentPromptUsage = addUsage(currentPromptUsage, usage);
            // See the note on the other subscriber: the reason a turn produced
            // nothing arrives here and is worth more than any guess about it.
            providerFailure =
              message.stopReason === "error"
                ? describeProviderFailure(message.errorMessage) ?? providerFailure
                : null;
            lastCall = lastCallOf(message, messageText);
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
          const stopsAtQuestion = !isError && isQuestionOnCard(toolName, output);
          if (stopsAtQuestion) webCardQuestion = cardQuestionFrom(existing?.input) ?? webCardQuestion ?? null;
          tools.set(toolCallId, toolRecord);
          upsertTimelineTool(timelineParts, toolRecord);
          checkpointProgress();

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
          // After the result is out, not before: whoever handed this turn over reads the question
          // from that result, and a stopped turn writes nothing more to its stream.
          if (stopsAtQuestion) runAbort.abort();
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
        // Did the work and wrote no answer: asked once more, out of the person's sight.
        if (endedWithoutAnswer(lastCall, tools.values(), currentPromptUsage)) {
          await session.prompt(ANSWER_NUDGE);
          if (aborted) {
            await abortPromise;
            await persistPartialAssistant();
            return;
          }
          currentPromptUsage = subtractUsage(getSessionTokenUsage(session), baselineUsage);
          if (endedWithoutAnswer(lastCall, tools.values(), currentPromptUsage)) {
            closeTextPart();
            appendNotice(tCompaction("chat.errors.noFinalAfterTools"));
          }
        }
        // Failed after doing some of the work: the provider's own reason is the answer's last line.
        const failedAfterWork = await failureAfterWork(lastCall ?? { text: "" }, providerFailure);
        if (failedAfterWork) {
          closeTextPart();
          appendNotice(failedAfterWork);
          turnFailure = failedAfterWork;
        }
        const finalStats = buildPiRuntimeStats(session, currentPromptUsage, addUsage(baselineUsage, currentPromptUsage));
        emitStats(finalStats);
        closeTextPart();
        cancelProgressCheckpoint();
        const producedFiles = await producedForTurn({
          chatId: options.chatId,
          tools: tools.values(),
          startedAt: turnStartedAt,
          cwd: session.sessionManager.getCwd(),
          projectId: options.projectId,
          assistantText,
        });
        turnFiles = producedFiles;
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
        turnFailure = errorText;
        persisted = true;
        cancelProgressCheckpoint();
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
        cardTurn?.end(
          webCardQuestion !== undefined
            ? { outcome: "question", ...(webCardQuestion ? { question: webCardQuestion } : {}) }
            : turnFailure !== null
            ? { outcome: "failed", detail: turnFailure }
            : stall.stalled
              ? stalledCardEnd(stall.stalled, stall.question)
              : aborted
                ? { outcome: "stopped" }
                : refusal !== null
                  ? { outcome: "refused", ...(refusal ? { detail: refusal } : {}) }
                  : { outcome: "done", finalText: lastMessageText || assistantText, files: turnFiles }
        );
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
