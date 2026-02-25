import type { ModelMessage } from "ai";

export interface AgentContext {
  chatId: string;
  projectId?: string;
  currentPath?: string; // relative path within the project for cwd
  memorySubdir: string;
  knowledgeSubdirs: string[];
  history: ModelMessage[];
  agentNumber: number;
  parentContext?: AgentContext;
  data: Record<string, unknown>;
}

export interface AgentLoopResult {
  response: string;
  toolCalls: AgentToolCallRecord[];
}

export interface AgentToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  timestamp: string;
}

export interface StreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onFinish?: (result: AgentLoopResult) => void;
}
