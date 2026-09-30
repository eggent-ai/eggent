import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import type { ChatContextMode } from "@/lib/types";

export interface PiSessionOptions {
  cwd?: string;
  agentDir?: string;
  tools?: string[];
  chatId?: string;
  projectId?: string;
  memorySubdir?: string;
  /**
   * How much of the workspace this run carries. Absent or "full" is the whole
   * thing; the light modes replace the system prompt and cut the tool list.
   * See buildLiteSystemPrompt in session.ts.
   */
  chatContextMode?: ChatContextMode;
  enableEggentTools?: boolean;
  /**
   * Optional escape hatch for tests/debugging: when true, disables pi-discovered
   * extensions/skills/prompts/themes. By default Eggent allows all global pi packages.
   */
  corePiToolsOnly?: boolean;
  /**
   * Hidden runtime data for server-side custom tools. This must not be rendered
   * into prompts or persisted user-visible messages because it can contain
   * secrets such as Telegram bot tokens.
   */
  toolRuntimeData?: Record<string, unknown>;
  /** Abort signal for the active HTTP/chat request. */
  abortSignal?: AbortSignal;
  /** Stable id for the active Pi run; used by pending interaction responses. */
  runId?: string;
  /** Emits pending interaction updates from Pi extension UI prompts. */
  onPiInteraction?: (interaction: PiPendingInteraction) => void;
}

export interface PiChatRunOptions extends PiSessionOptions {
  chatId: string;
  userMessage: string;
  projectId?: string;
}

/**
 * What a turn is doing while it runs, for a surface that shows the answer as
 * it is written rather than when it is finished. `text` deltas concatenate to
 * exactly the reply the turn returns.
 */
export type AgentProgressEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "end" }
  /** Helpers started with the Agent tool: how many of this turn's are still working. */
  | { type: "helpers"; running: number; total: number };

export interface PiRuntimeStats {
  model?: {
    provider?: string;
    id?: string;
    name?: string;
  };
  lastTurn?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  session?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    cost?: number;
  };
  context?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

/** Where a helper started by the Agent tool is. */
export type SubagentStatus = "running" | "done" | "failed" | "stopped";

/** One thing a helper did: the tool, and what it was pointed at. */
export interface SubagentStep {
  tool: string;
  /** The query, page, file or command - clipped, with anything secret masked. */
  target?: string;
  failed?: boolean;
}

/**
 * A helper as the chat shows it: what it is doing, what it has done, how it
 * ended. Built on the server from the Agent tool's own progress reports and
 * the helper's transcript, streamed while it works and kept with the stored
 * message afterwards. What it was asked is the tool call's own input and what
 * it found is the tool's result; neither is repeated here.
 */
export interface SubagentSnapshot {
  toolCallId: string;
  description: string;
  agentType?: string;
  model?: string;
  status: SubagentStatus;
  startedAt: string;
  endedAt?: string;
  /** What it is doing at this moment; only while it runs. */
  now?: {
    kind: "thinking" | "queued" | "tool" | "writing";
    /** Runtime tool names, for kind "tool". */
    tools?: string[];
    /** The start of what it is writing, for kind "writing". */
    text?: string;
  };
  toolUses: number;
  turns?: number;
  tokens?: number;
  steps: SubagentStep[];
  /** Steps left out of `steps` because there were too many to keep. */
  earlierSteps?: number;
  error?: string;
}

export type PiToolStatus = "running" | "completed" | "error";

export interface PiToolRecord {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  status: PiToolStatus;
}
