import { createUIMessageStream } from "ai";
import type { UIMessage } from "ai";
import { createEggentPiSession } from "@/lib/pi/session";
import { retainPiScheduleSession, takeRetainedPiScheduleSession } from "@/lib/pi/schedule-host";
import type { PiChatRunOptions, PiRuntimeStats, PiToolRecord } from "@/lib/pi/types";
import { getChat, saveChat } from "@/lib/storage/chat-store";
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

function formatPiChatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, " ").trim();
  const message = compact || "The model stopped before producing a final response.";
  const short = message.length > 500 ? `${message.slice(0, 500)}...` : message;
  return `Generation failed: ${short}`;
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

function emptyZeroTokenTurnError(): Error {
  return new Error(
    "Model returned an empty response with 0 tokens. The provider may be rate-limiting, out of quota, or refusing this model. Try another model or reconnect the provider."
  );
}

function hasScheduleManagementIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsSchedules =
    /\b(scheduled|schedule|schedules|reminders?|jobs?)\b/.test(normalized) ||
    /(запланирован|расписани|напоминани|задач)/i.test(text);
  const managementVerb =
    /\b(cancel|delete|remove|clear|list|show|what|which)\b/.test(normalized) ||
    /(убери|удали|отмени|очисти|покажи|выведи|какие|список)/i.test(text);
  return mentionsSchedules && managementVerb;
}

function hasScheduleIntent(text: string): boolean {
  if (hasScheduleManagementIntent(text)) return false;
  const normalized = text.toLowerCase();
  return (
    /\b(in|after)\s+\d+\s*(seconds?|secs?|minutes?|mins?|hours?|days?)\b/.test(normalized) ||
    /\b(tomorrow|tonight|daily|weekly|monthly|every\s+\w+|remind\s+me|schedule)\b/.test(normalized) ||
    /\b(at)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/.test(normalized) ||
    /через\s+\d+\s*(секунд[уы]?|сек\.?|минут[уы]?|мин\.?|час(а|ов)?|дн(я|ей)?)/i.test(text) ||
    /(завтра|послезавтра|сегодня\s+в|напомни|напомнить|по\s+расписанию|кажд(ый|ую|ое)|ежедневно|еженедельно)/i.test(text)
  );
}

function applySchedulingToolPolicy(
  session: {
    getActiveToolNames: () => string[];
    setActiveToolsByName: (toolNames: string[]) => void;
    getToolDefinition?: (toolName: string) => unknown;
  },
  text: string
) {
  const activeTools = session.getActiveToolNames();
  if (hasScheduleManagementIntent(text)) {
    session.setActiveToolsByName(activeTools.filter((toolName) => toolName !== "Agent" && toolName !== "bash"));
    return;
  }
  if (hasScheduleIntent(text)) {
    if (activeTools.includes("bash")) {
      session.setActiveToolsByName(activeTools.filter((toolName) => toolName !== "bash"));
    }
    return;
  }

  // If a retained scheduler session was previously used for a scheduling turn,
  // restore bash for ordinary follow-up work.
  if (!activeTools.includes("bash") && session.getToolDefinition?.("bash")) {
    session.setActiveToolsByName([...activeTools, "bash"]);
  }
}

function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function preparePromptForRuntime(text: string): string {
  // Runtime slash commands such as /skill:name and prompt templates must stay
  // at the very beginning of the message so the SDK can expand them.
  if (isSlashCommand(text)) return text;
  if (hasScheduleManagementIntent(text)) {
    return [
      "Eggent schedule-management directive:",
      "- This user request asks to inspect or modify existing scheduled tasks.",
      "- Do not create a new scheduled Agent for this request.",
      "- Use eggent_manage_schedules with action=\"list\" or action=\"clear\".",
      "- For requests like 'убери все запланированные задачи', call eggent_manage_schedules with action=\"clear\" and scope=\"all\" unless the user explicitly says current project only.",
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
    "- The scheduled Agent prompt should contain the actual work to perform at fire time.",
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
  if (userMessageCount === 1 && chat.title === "New Chat") {
    chat.title =
      options.userMessage.slice(0, 60) +
      (options.userMessage.length > 60 ? "..." : "");
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

export async function runPiAgentText(options: PiChatRunOptions & { runtimeData?: Record<string, unknown>; toolRuntimeData?: Record<string, unknown> }): Promise<string> {
  const userMessageId = crypto.randomUUID();
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
  });

  let assistantText = "";
  let lastTurnUsage: PiRuntimeStats["lastTurn"] | undefined;
  let currentPromptUsage: PiRuntimeStats["lastTurn"] | undefined;
  const baselineUsage = getSessionTokenUsage(session);
  const tools = new Map<string, PiToolRecord>();
  const timelineParts: ChatMessagePart[] = [];

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
      const toolRecord: PiToolRecord = {
        toolCallId,
        toolName,
        input: existing?.input ?? {},
        output: getToolResult(record),
        status: record.isError === true ? "error" : "completed",
      };
      tools.set(toolCallId, toolRecord);
      upsertTimelineTool(timelineParts, toolRecord);
    }
  });

  try {
    applySchedulingToolPolicy(session, prompt);
    await session.prompt(preparePromptForRuntime(prompt));
    currentPromptUsage = currentPromptUsage ?? subtractUsage(getSessionTokenUsage(session), baselineUsage);
    lastTurnUsage = lastTurnUsage ?? currentPromptUsage;
    if (isEmptyZeroTokenTurn(assistantText, tools.values(), currentPromptUsage)) {
      throw emptyZeroTokenTurnError();
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
    unsubscribe();
    const retained = await retainPiScheduleSession({
      chatId: options.chatId,
      projectId: options.projectId,
      session,
    });
    if (!retained) session.dispose();
  }
}

export function createPiChatUIMessageStream(options: PiChatRunOptions) {
  const userMessageId = crypto.randomUUID();

  return createUIMessageStream<UIMessage>({
    async execute({ writer }) {
      await persistUserMessage(options, userMessageId);

      const session = takeRetainedPiScheduleSession(options.chatId) ?? await createEggentPiSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        tools: options.tools,
        chatId: options.chatId,
        projectId: options.projectId,
      });

      let assistantText = "";
      let textStarted = false;
      let currentTextId: string | null = null;
      let lastTurnUsage: PiRuntimeStats["lastTurn"] | undefined;
      let currentPromptUsage: PiRuntimeStats["lastTurn"] | undefined;
      const baselineUsage = getSessionTokenUsage(session);
      const tools = new Map<string, PiToolRecord>();
      const timelineParts: ChatMessagePart[] = [];
      let aborted = options.abortSignal?.aborted === true;
      let persisted = false;
      let abortPromise: Promise<void> | null = null;

      const safeWrite = (part: Parameters<typeof writer.write>[0]) => {
        if (aborted) return;
        writer.write(part);
      };

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
        await session.prompt(preparePromptForRuntime(options.userMessage));

        if (aborted) {
          await abortPromise;
          await persistPartialAssistant();
          return;
        }

        currentPromptUsage = currentPromptUsage ?? subtractUsage(getSessionTokenUsage(session), baselineUsage);
        lastTurnUsage = lastTurnUsage ?? currentPromptUsage;
        if (isEmptyZeroTokenTurn(assistantText, tools.values(), currentPromptUsage)) {
          throw emptyZeroTokenTurnError();
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
        const errorText = formatPiChatError(error);
        closeTextPart();
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
        options.abortSignal?.removeEventListener("abort", handleAbort);
        unsubscribe();
        if (aborted) {
          session.dispose();
          return;
        }
        const retained = await retainPiScheduleSession({
          chatId: options.chatId,
          projectId: options.projectId,
          session,
        });
        if (!retained) session.dispose();
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return message || "pi chat failed";
    },
  });
}
