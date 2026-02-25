// ============================================================
// Core type definitions for Eggent
// ============================================================

// --- Settings ---

export interface ModelConfig {
  provider: "openai" | "anthropic" | "google" | "openrouter" | "ollama" | "custom";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AppSettings {
  chatModel: ModelConfig;
  utilityModel: ModelConfig;
  embeddingsModel: {
    provider: "openai" | "openrouter" | "google" | "ollama" | "custom" | "mock";
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  codeExecution: {
    enabled: boolean;
    timeout: number; // seconds
    maxOutputLength: number; // characters
  };
  memory: {
    enabled: boolean;
    similarityThreshold: number; // 0-1
    maxResults: number;
    chunkSize: number; // characters per chunk for knowledge ingestion
  };
  search: {
    enabled: boolean;
    provider: "searxng" | "tavily" | "none";
    apiKey?: string;
    baseUrl?: string;
  };
  general: {
    darkMode: boolean;
    language: string;
  };
  auth: {
    enabled: boolean;
    username: string;
    passwordHash: string;
    mustChangeCredentials: boolean;
  };
}

// --- Chat ---

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  toolResult?: unknown;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  attachments?: Attachment[];
}

export interface Attachment {
  name: string;
  type: string;
  url?: string;
  path?: string;
}

export interface Chat {
  id: string;
  title: string;
  projectId?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatListItem {
  id: string;
  title: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** File uploaded to a specific chat session */
export interface ChatFile {
  name: string;
  path: string;       // full absolute path
  size: number;
  type: string;       // MIME type or extension
  uploadedAt: string;
}

// --- Projects ---

export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: "global" | "isolated";
  createdAt: string;
  updatedAt: string;
}

/**
 * Project Skill (Agent Skills spec: https://agentskills.io/specification).
 * Each skill is a directory under .meta/skills/<skill-name>/ with SKILL.md.
 */
export interface ProjectSkill {
  /** Matches directory name; lowercase, hyphens, 1–64 chars */
  name: string;
  /** What the skill does and when to use it; 1–1024 chars */
  description: string;
  /** Markdown body of SKILL.md (instructions) */
  body: string;
  /** Optional fields from frontmatter */
  license?: string;
  compatibility?: string;
  /** Path to skill directory (for references/scripts/assets) */
  skillDir: string;
}

/** Skill metadata only (for system prompt; full body loaded on activate). */
export interface ProjectSkillMetadata {
  name: string;
  description: string;
  skillDir: string;
}

// --- Memory ---

export enum MemoryArea {
  MAIN = "main",
  FRAGMENTS = "fragments",
  SOLUTIONS = "solutions",
  INSTRUMENTS = "instruments",
}

export interface MemoryEntry {
  id: string;
  text: string;
  area: MemoryArea;
  metadata: Record<string, unknown>;
  score?: number;
  createdAt: string;
}

export interface VectorDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

// --- Knowledge ---

export interface KnowledgeFile {
  path: string;
  name: string;
  type: string;
  size: number;
  checksum: string;
  state: "new" | "original" | "changed" | "removed";
  documentIds: string[];
}

// --- Agent ---

export interface AgentConfig {
  chatModel: ModelConfig;
  utilityModel: ModelConfig;
  embeddingsModel: AppSettings["embeddingsModel"];
  memorySubdir: string;
  knowledgeSubdirs: string[];
  projectId?: string;
}

export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  breakLoop?: boolean;
}

// --- Code Execution ---

export interface ShellSession {
  id: number;
  pid?: number;
  isRunning: boolean;
  lastOutput: string;
}

export interface CodeExecutionResult {
  output: string;
  exitCode?: number;
  error?: string;
}

// --- MCP (Model Context Protocol) ---

/** Normalized project MCP config (after parsing). */
export interface ProjectMcpConfig {
  servers: McpServerConfig[];
}

export type McpServerConfig =
  | McpServerConfigStdio
  | McpServerConfigHttp;

export interface McpServerConfigStdio {
  id: string;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerConfigHttp {
  id: string;
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Cursor-compatible format for .meta/mcp/servers.json.
 * Key = server id; value with `command` = stdio, with `url` = http.
 * @see https://docs.cursor.com/context/model-context-protocol
 */
export interface McpServersFileCursor {
  mcpServers: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { url: string; headers?: Record<string, string> }
  >;
}

// --- API ---

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
