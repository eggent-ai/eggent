export interface PiSessionOptions {
  cwd?: string;
  agentDir?: string;
  tools?: string[];
  chatId?: string;
  projectId?: string;
  memorySubdir?: string;
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
}

export interface PiChatRunOptions extends PiSessionOptions {
  chatId: string;
  userMessage: string;
  projectId?: string;
}

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

export type PiToolStatus = "running" | "completed" | "error";

export interface PiToolRecord {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  status: PiToolStatus;
}
