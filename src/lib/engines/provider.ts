/**
 * The "model" a session on an engine talks to.
 *
 * The program that does the work is a whole agent with its own tools, so there
 * is nothing for a language model to decide here. This stand-in does what the
 * runtime expects of one in the plainest way: asked something new, it answers
 * with a call to the engine tool carrying the person's words; shown that tool's
 * result, it answers with that text. Everything the rest of the application
 * does around a turn - storing it, stopping it, relaying it to the other side
 * of a pair, watching it for silence - then works as it does for any model,
 * because from outside this is one.
 */
import { randomUUID } from "node:crypto";
import { EngineEventStream } from "@/lib/engines/stream";
import { ENGINE_TOOL_NAME, type EngineModelInfo } from "@/lib/engines/types";

/** The few fields of the runtime's model, context and message types this reads. */
interface StandInModel {
  id: string;
  api: string;
  provider: string;
}

interface StandInMessage {
  role?: string;
  content?: unknown;
  toolName?: string;
}

interface StandInContext {
  messages?: StandInMessage[];
}

interface StandInOptions {
  signal?: AbortSignal;
}

interface StandInMessageOut {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: "stop" | "toolUse" | "aborted" | "error";
  errorMessage?: string;
  timestamp: number;
}

type StandInEvent =
  | { type: "start"; partial: StandInMessageOut }
  | { type: "text_start"; contentIndex: number; partial: StandInMessageOut }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: StandInMessageOut }
  | { type: "text_end"; contentIndex: number; content: string; partial: StandInMessageOut }
  | { type: "toolcall_start"; contentIndex: number; partial: StandInMessageOut }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: StandInMessageOut }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }; partial: StandInMessageOut }
  | { type: "done"; reason: "stop" | "toolUse"; message: StandInMessageOut }
  | { type: "error"; reason: "aborted" | "error"; error: StandInMessageOut };

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function emptyMessage(model: StandInModel): StandInMessageOut {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** The custom API id the stand-in is registered under. */
export const ENGINE_API = "eggent-engine";

export function engineStreamSimple(model: StandInModel, context: StandInContext, options?: StandInOptions) {
  const stream = new EngineEventStream<StandInEvent, StandInMessageOut>(
    (event) => event.type === "done" || event.type === "error",
    (event) => (event.type === "done" ? event.message : (event as { error: StandInMessageOut }).error),
  );

  queueMicrotask(() => {
    try {
      if (options?.signal?.aborted) {
        const aborted = { ...emptyMessage(model), stopReason: "aborted" as const, errorMessage: "Aborted" };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        return;
      }
      const messages = Array.isArray(context.messages) ? context.messages : [];
      const last = messages[messages.length - 1];

      if (last?.role === "toolResult" && last.toolName === ENGINE_TOOL_NAME) {
        // The engine has answered: the answer is the reply.
        const text = messageText(last.content).trim() || "(no answer)";
        const finished: StandInMessageOut = { ...emptyMessage(model), content: [{ type: "text", text }] };
        const opened: StandInMessageOut = { ...emptyMessage(model), content: [{ type: "text", text: "" }] };
        stream.push({ type: "start", partial: opened });
        stream.push({ type: "text_start", contentIndex: 0, partial: opened });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: finished });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: finished });
        stream.push({ type: "done", reason: "stop", message: finished });
        return;
      }

      // Something new from the person: hand it to the engine.
      const prompt = last?.role === "user" ? messageText(last.content).trim() : "";
      const call = {
        type: "toolCall" as const,
        id: `engine_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        name: ENGINE_TOOL_NAME,
        arguments: { prompt },
      };
      const opened: StandInMessageOut = { ...emptyMessage(model), content: [{ ...call, arguments: {} }] };
      const finished: StandInMessageOut = { ...emptyMessage(model), content: [call], stopReason: "toolUse" };
      stream.push({ type: "start", partial: opened });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: opened });
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: finished });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: finished });
      stream.push({ type: "done", reason: "toolUse", message: finished });
    } catch (error) {
      const failed = {
        ...emptyMessage(model),
        stopReason: "error" as const,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      stream.push({ type: "error", reason: "error", error: failed });
    }
  });

  return stream;
}

/** The id a model is registered under: an empty id is the engine's own default. */
export function engineRegisteredModelId(modelId: string): string {
  return modelId || "default";
}

/** What the runtime's model registry is told about one engine and its models. */
export function engineProviderConfig(engineId: string, label: string, models: EngineModelInfo[]) {
  return {
    name: label,
    baseUrl: `engine://${engineId}`,
    // A literal: the runtime wants a credential before it will use a provider.
    apiKey: "engine",
    api: ENGINE_API,
    streamSimple: engineStreamSimple,
    models: models.map((model) => ({
      id: engineRegisteredModelId(model.id),
      name: model.label,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    })),
  };
}
