import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import path from "path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { spawn } from "child_process";
import {
  ModelConfig,
  type McpServerConfig,
  type ProjectMcpConfig,
} from "@/lib/types";
import {
  getWorkDir,
  loadProjectMcpServers,
} from "@/lib/storage/project-store";
import { resolveCliOAuthCredentialSync } from "@/lib/providers/provider-auth";

type OpenAICompatibleSettings = {
  providerName: string;
  apiKey: string;
  allowMissingApiKey?: boolean;
  baseUrl?: string;
  fallbackBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultPath?: string;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

type CliProviderName = "codex-cli" | "gemini-cli";
const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
const GEMINI_CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com";
const GEMINI_CODE_ASSIST_API_VERSION = "v1internal";
const GEMINI_CODE_ASSIST_LOAD_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
];
const GEMINI_CODE_ASSIST_USER_AGENT = "google-api-nodejs-client/9.15.1";
const DEFAULT_CODEX_INSTRUCTIONS = "You are Eggent, an AI coding assistant.";
const CODEX_UNSUPPORTED_FIELDS = new Set(["max_output_tokens"]);
const GEMINI_CODE_ASSIST_SCHEMA_BLOCKLIST = new Set([
  "$id",
  "$schema",
  "$defs",
  "definitions",
  "$ref",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "prefixItems",
]);
const GEMINI_FREE_TIER_ID = "free-tier";
const GEMINI_ONBOARD_MAX_POLLS = 8;
const GEMINI_ONBOARD_POLL_DELAY_MS = 1500;
const geminiProjectIdCache = new Map<string, string | null>();
const geminiSessionIdCache = new Map<string, string>();

function extractCodexUnsupportedParameter(errorBody: string): string | null {
  const match = errorBody.match(/unsupported parameter:\s*([a-zA-Z0-9_.-]+)/i);
  const candidate = match?.[1]?.trim();
  return candidate || null;
}

export interface ModelRuntimeContext {
  projectId?: string;
  currentPath?: string;
}

interface CliCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const ENABLE_SUBPROCESS_CLI_FALLBACK = process.env.EGGENT_USE_SUBPROCESS_CLI === "1";

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
};

function collectPromptText(options: LanguageModelV3CallOptions): string {
  const chunks: string[] = [];

  for (const message of options.prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        if (text.trim()) {
          chunks.push(text);
        }
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function runCliCommand(
  command: string,
  args: string[],
  options?: { stdinText?: string; timeoutMs?: number; cwd?: string }
): Promise<CliCommandResult> {
  const timeoutMs = options?.timeoutMs ?? 180000;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        cwd: options?.cwd,
      });
    } catch (error) {
      resolve({
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!done) {
        timedOut = true;
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200000) {
        stdout = stdout.slice(-200000);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200000) {
        stderr = stderr.slice(-200000);
      }
    });

    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (options?.stdinText) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

function toEnvRecord(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key) continue;
    out[key] = String(v);
  }
  return out;
}

function tomlQuote(value: string): string {
  let out = "\"";
  for (const char of value) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case "\"":
        out += "\\\"";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += char;
    }
  }
  out += "\"";
  return out;
}

function stableCodexServerKey(id: string, used: Set<string>): string {
  let base = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "mcp";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  const withIndex = `${base}_${index}`;
  used.add(withIndex);
  return withIndex;
}

function pushCodexStdioOverrides(overrides: string[], key: string, server: McpServerConfig): void {
  if (server.transport !== "stdio") return;
  const command = server.command?.trim();
  if (!command) return;

  overrides.push(`mcp_servers.${key}.command=${tomlQuote(command)}`);

  const args = (server.args || []).map((arg) => arg.trim()).filter(Boolean);
  if (args.length > 0) {
    overrides.push(
      `mcp_servers.${key}.args=[${args.map((arg) => tomlQuote(arg)).join(", ")}]`
    );
  }

  const env = toEnvRecord(server.env);
  const envEntries = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${tomlQuote(name)} = ${tomlQuote(value)}`);
  if (envEntries.length > 0) {
    overrides.push(`mcp_servers.${key}.env={${envEntries.join(", ")}}`);
  }

  if (server.cwd?.trim()) {
    overrides.push(`mcp_servers.${key}.cwd=${tomlQuote(server.cwd.trim())}`);
  }
}

function pushCodexHttpOverrides(overrides: string[], key: string, server: McpServerConfig): void {
  if (server.transport !== "http") return;
  const url = server.url?.trim();
  if (!url) return;

  overrides.push(`mcp_servers.${key}.url=${tomlQuote(url)}`);

  const headers = toEnvRecord(server.headers);
  const headerEntries = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${tomlQuote(name)} = ${tomlQuote(value)}`);
  if (headerEntries.length > 0) {
    overrides.push(`mcp_servers.${key}.headers={${headerEntries.join(", ")}}`);
  }
}

function buildCodexMcpOverrides(config: ProjectMcpConfig | null): string[] {
  if (!config?.servers?.length) return [];
  const overrides: string[] = [];
  const used = new Set<string>();

  for (const server of config.servers) {
    const key = stableCodexServerKey(server.id, used);
    pushCodexStdioOverrides(overrides, key, server);
    pushCodexHttpOverrides(overrides, key, server);
  }

  return overrides;
}

async function resolveCodexMcpOverrides(projectId: string | undefined): Promise<string[]> {
  if (!projectId) return [];
  try {
    const config = await loadProjectMcpServers(projectId);
    return buildCodexMcpOverrides(config);
  } catch {
    return [];
  }
}

function resolveCliWorkingDirectory(runtime: ModelRuntimeContext | undefined): string {
  const projectId = runtime?.projectId;
  if (!projectId) {
    return process.cwd();
  }

  const root = path.resolve(getWorkDir(projectId));
  const rawCurrentPath = (runtime.currentPath || "").trim();
  if (!rawCurrentPath) return root;

  const candidate = path.resolve(root, rawCurrentPath);
  if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
    return candidate;
  }

  return root;
}

function parseCodexOutput(rawStdout: string, rawStderr: string): string {
  const lines = rawStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const texts: string[] = [];
  let explicitError = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const eventType = typeof parsed.type === "string" ? parsed.type : "";

      if (eventType === "item.completed") {
        const item = parsed.item as Record<string, unknown> | undefined;
        const itemType = typeof item?.type === "string" ? item.type : "";
        const text = typeof item?.text === "string" ? item.text : "";
        if (itemType === "agent_message" && text.trim()) {
          texts.push(text.trim());
        }
      }

      if (eventType === "error") {
        const message =
          typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : "";
        if (message.trim()) {
          explicitError = message.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  if (texts.length > 0) {
    return texts.join("\n\n");
  }

  if (explicitError) {
    return explicitError;
  }

  const fallback = `${rawStdout}\n${rawStderr}`.trim();
  return fallback || "Codex CLI returned no output.";
}

function parseGeminiOutput(rawStdout: string, rawStderr: string): string {
  const lines = rawStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let text = "";
  let explicitError = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const eventType = typeof parsed.type === "string" ? parsed.type : "";

      if (eventType === "message") {
        const role = typeof parsed.role === "string" ? parsed.role : "";
        const content = typeof parsed.content === "string" ? parsed.content : "";
        if (role === "assistant" && content) {
          text += content;
        }
      }

      if (eventType === "error") {
        const message =
          typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : "";
        if (message.trim()) {
          explicitError = message.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  if (text.trim()) {
    return text.trim();
  }
  if (explicitError) {
    return explicitError;
  }

  const fallback = `${rawStdout}\n${rawStderr}`.trim();
  return fallback || "Gemini CLI returned no output.";
}

async function runCliModel(
  provider: CliProviderName,
  model: string,
  prompt: string,
  runtime: ModelRuntimeContext | undefined
): Promise<string> {
  const cwd = resolveCliWorkingDirectory(runtime);

  if (provider === "codex-cli") {
    const command = process.env.CODEX_COMMAND || "codex";
    const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
    const codexMcpOverrides = await resolveCodexMcpOverrides(runtime?.projectId);
    for (const override of codexMcpOverrides) {
      args.push("-c", override);
    }
    if (model) {
      args.push("-m", model);
    }
    args.push("-");

    const result = await runCliCommand(command, args, {
      stdinText: `${prompt}\n`,
      timeoutMs: 240000,
      cwd,
    });

    if (result.timedOut) {
      throw new Error("Codex CLI timed out.");
    }
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error((result.stderr || "Codex CLI execution failed.").trim());
    }

    return parseCodexOutput(result.stdout, result.stderr);
  }

  const command = process.env.GEMINI_CLI_COMMAND || "gemini";
  const args = ["-m", model, "-p", prompt, "--output-format", "stream-json", "--yolo"];
  const result = await runCliCommand(command, args, { timeoutMs: 240000, cwd });

  if (result.timedOut) {
    throw new Error("Gemini CLI timed out.");
  }
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error((result.stderr || "Gemini CLI execution failed.").trim());
  }

  return parseGeminiOutput(result.stdout, result.stderr);
}

function createCliLanguageModel(
  provider: CliProviderName,
  config: ModelConfig,
  runtime: ModelRuntimeContext | undefined
): LanguageModel {
  const modelId = config.model || (provider === "codex-cli" ? "gpt-5.2-codex" : "gemini-2.5-pro");

  const generate = async (
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> => {
    const prompt = collectPromptText(options);
    const text = await runCliModel(
      provider,
      modelId,
      prompt || "Continue.",
      runtime
    );

    return {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: EMPTY_USAGE,
      warnings: [],
      request: {
        body: {
          provider,
          model: modelId,
          promptLength: prompt.length,
        },
      },
    };
  };

  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: generate,
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const generated = await generate(options);
      const textPart = generated.content.find(
        (part): part is { type: "text"; text: string } => part.type === "text"
      );
      const text = textPart?.text || "";
      const id = crypto.randomUUID();

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id });
          if (text) {
            controller.enqueue({ type: "text-delta", id, delta: text });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            finishReason: generated.finishReason,
            usage: generated.usage,
          });
          controller.close();
        },
      });

      return { stream };
    },
  };

  return model as unknown as LanguageModel;
}

function createCodexOauthFetch(credential: {
  accessToken: string;
  accountId?: string;
}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("accept", "application/json");
    if (credential.accountId) {
      headers.set("chatgpt-account-id", credential.accountId);
    }

    if (request.method.toUpperCase() !== "POST") {
      return fetch(new Request(request, { headers }));
    }

    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return fetch(new Request(request, { headers }));
    }

    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.store !== false) {
        parsed.store = false;
      }
      if (typeof parsed.instructions !== "string" || !parsed.instructions.trim()) {
        parsed.instructions = DEFAULT_CODEX_INSTRUCTIONS;
      }
      for (const key of CODEX_UNSUPPORTED_FIELDS) {
        if (key in parsed) {
          delete parsed[key];
        }
      }
      let response = await fetch(
        new Request(request, {
          headers,
          body: JSON.stringify(parsed),
        })
      );
      if (response.status === 400) {
        const errorBody = await response.clone().text().catch(() => "");
        const unsupportedField = extractCodexUnsupportedParameter(errorBody);
        if (unsupportedField && unsupportedField in parsed) {
          delete parsed[unsupportedField];
          response = await fetch(
            new Request(request, {
              headers,
              body: JSON.stringify(parsed),
            })
          );
        }
      }
      return response;
    } catch {
      return fetch(
        new Request(request, {
          headers,
          body: rawBody,
        })
      );
    }
  };
}

function resolveGeminiCodeAssistPlatform(): "WINDOWS" | "MACOS" | "PLATFORM_UNSPECIFIED" {
  if (process.platform === "win32") {
    return "WINDOWS";
  }
  if (process.platform === "darwin") {
    return "MACOS";
  }
  return "PLATFORM_UNSPECIFIED";
}

function getGeminiEnvProjectId(): string | undefined {
  const candidate = (process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  return candidate || undefined;
}

function extractGeminiCodeAssistProjectId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const direct = record.cloudaicompanionProject;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (
    direct &&
    typeof direct === "object" &&
    !Array.isArray(direct) &&
    typeof (direct as Record<string, unknown>).id === "string"
  ) {
    const directId = (direct as Record<string, unknown>).id as string;
    if (directId.trim()) {
      return directId.trim();
    }
  }

  const nested = record.response;
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    (nested as Record<string, unknown>).cloudaicompanionProject &&
    typeof (nested as Record<string, unknown>).cloudaicompanionProject === "object"
  ) {
    const nestedProject = ((nested as Record<string, unknown>).cloudaicompanionProject as Record<string, unknown>).id;
    if (typeof nestedProject === "string" && nestedProject.trim()) {
      return nestedProject.trim();
    }
  }

  return undefined;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGeminiCurrentTierId(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const currentTier = payload.currentTier;
  if (!isPlainRecord(currentTier)) {
    return undefined;
  }
  const id = currentTier.id;
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  return undefined;
}

function extractGeminiDefaultAllowedTierId(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const allowed = payload.allowedTiers;
  if (!Array.isArray(allowed)) {
    return undefined;
  }

  for (const entry of allowed) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const isDefault = entry.isDefault === true;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (isDefault && id) {
      return id;
    }
  }

  for (const entry of allowed) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id) {
      return id;
    }
  }

  return undefined;
}

function extractGeminiOperationName(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const name = payload.name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return undefined;
}

async function pollGeminiOnboardOperation(params: {
  endpoint: string;
  operationName: string;
  accessToken: string;
  apiClient: string;
}): Promise<unknown> {
  const operationPath = params.operationName.replace(/^\/+/, "");
  for (let attempt = 0; attempt < GEMINI_ONBOARD_MAX_POLLS; attempt += 1) {
    if (attempt > 0) {
      await sleep(GEMINI_ONBOARD_POLL_DELAY_MS);
    }
    try {
      const response = await fetch(
        `${params.endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}/${operationPath}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${params.accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            "x-goog-api-client": params.apiClient,
            "user-agent": GEMINI_CODE_ASSIST_USER_AGENT,
          },
        }
      );
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!isPlainRecord(payload)) {
        continue;
      }
      if (payload.done === true || payload.response !== undefined) {
        return payload;
      }
    } catch {
      // Ignore poll failures; caller handles fallback.
    }
  }
  return undefined;
}

async function resolveGeminiCodeAssistProjectId(params: {
  accessToken: string;
  apiClient: string;
  preferredEndpoint?: string;
}): Promise<string | undefined> {
  const envProject = getGeminiEnvProjectId();
  if (envProject) {
    return envProject;
  }

  const cached = geminiProjectIdCache.get(params.accessToken);
  if (cached !== undefined) {
    return cached || undefined;
  }

  const endpoints = [
    params.preferredEndpoint,
    ...GEMINI_CODE_ASSIST_LOAD_ENDPOINTS,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeEndpoint(value));

  const deduped = [...new Set(endpoints)];
  const metadataPayload = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };

  for (const endpoint of deduped) {
    const loadBody = {
      ...(envProject ? { cloudaicompanionProject: envProject } : {}),
      metadata: {
        ...metadataPayload,
        ...(envProject ? { duetProject: envProject } : {}),
      },
    };

    try {
      const response = await fetch(`${endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}:loadCodeAssist`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-goog-api-client": params.apiClient,
          "user-agent": GEMINI_CODE_ASSIST_USER_AGENT,
        },
        body: JSON.stringify(loadBody),
      });

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      const projectId = extractGeminiCodeAssistProjectId(payload);
      if (projectId) {
        geminiProjectIdCache.set(params.accessToken, projectId);
        return projectId;
      }

      if (extractGeminiCurrentTierId(payload)) {
        continue;
      }

      const tierId = extractGeminiDefaultAllowedTierId(payload) || GEMINI_FREE_TIER_ID;
      const onboardBody: Record<string, unknown> = {
        tierId,
        metadata: {
          ...metadataPayload,
          ...(envProject && tierId !== GEMINI_FREE_TIER_ID ? { duetProject: envProject } : {}),
        },
      };
      if (envProject && tierId !== GEMINI_FREE_TIER_ID) {
        onboardBody.cloudaicompanionProject = envProject;
      }

      const onboardResponse = await fetch(`${endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}:onboardUser`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-goog-api-client": params.apiClient,
          "user-agent": GEMINI_CODE_ASSIST_USER_AGENT,
        },
        body: JSON.stringify(onboardBody),
      });
      if (!onboardResponse.ok) {
        continue;
      }

      const onboardPayload = (await onboardResponse.json().catch(() => null)) as unknown;
      const onboardProjectId = extractGeminiCodeAssistProjectId(onboardPayload);
      if (onboardProjectId) {
        geminiProjectIdCache.set(params.accessToken, onboardProjectId);
        return onboardProjectId;
      }

      const operationName = extractGeminiOperationName(onboardPayload);
      if (!operationName) {
        continue;
      }

      const finalPayload = await pollGeminiOnboardOperation({
        endpoint,
        operationName,
        accessToken: params.accessToken,
        apiClient: params.apiClient,
      });
      const finalProjectId = extractGeminiCodeAssistProjectId(finalPayload);
      if (finalProjectId) {
        geminiProjectIdCache.set(params.accessToken, finalProjectId);
        return finalProjectId;
      }
    } catch {
      // Ignore discovery errors; we'll proceed without project if needed.
    }
  }

  return undefined;
}

function parseGeminiModelMethod(pathname: string): {
  modelId: string;
  method: "generateContent" | "streamGenerateContent";
} | null {
  const marker = "/models/";
  const markerIndex = pathname.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const tail = pathname.slice(markerIndex + marker.length);
  const methodIndex = tail.lastIndexOf(":");
  if (methodIndex <= 0) {
    return null;
  }

  const method = tail.slice(methodIndex + 1);
  if (method !== "generateContent" && method !== "streamGenerateContent") {
    return null;
  }

  const modelId = decodeURIComponent(tail.slice(0, methodIndex)).trim();
  if (!modelId) {
    return null;
  }

  return {
    modelId,
    method,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeGeminiCodeAssistSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiCodeAssistSchema(item));
  }
  if (!isPlainRecord(schema)) {
    return schema;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_CODE_ASSIST_SCHEMA_BLOCKLIST.has(key)) {
      continue;
    }
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    if (
      key === "type" &&
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const normalizedTypes = value.filter((entry) => entry !== "null");
      out.type = normalizedTypes.length === 1 ? normalizedTypes[0] : normalizedTypes;
      continue;
    }
    if (key === "additionalProperties" && value !== false) {
      continue;
    }
    out[key] = sanitizeGeminiCodeAssistSchema(value);
  }
  return out;
}

function sanitizeGeminiCodeAssistRequest(requestBody: unknown): Record<string, unknown> {
  if (!isPlainRecord(requestBody)) {
    return {};
  }

  const sanitized: Record<string, unknown> = { ...requestBody };
  const tools = sanitized.tools;
  if (!Array.isArray(tools)) {
    return sanitized;
  }

  sanitized.tools = tools.map((tool) => {
    if (!isPlainRecord(tool)) {
      return tool;
    }
    const functionDeclarations = tool.functionDeclarations;
    if (!Array.isArray(functionDeclarations)) {
      return tool;
    }
    return {
      ...tool,
      functionDeclarations: functionDeclarations.map((declaration) => {
        if (!isPlainRecord(declaration)) {
          return declaration;
        }

        const result: Record<string, unknown> = { ...declaration };
        if ("parameters" in result) {
          result.parameters = sanitizeGeminiCodeAssistSchema(result.parameters);
        }
        if ("parametersJsonSchema" in result) {
          result.parametersJsonSchema = sanitizeGeminiCodeAssistSchema(result.parametersJsonSchema);
        }
        return result;
      }),
    };
  });

  return sanitized;
}

function buildGeminiCodeAssistRequestBody(params: {
  requestBody: unknown;
  modelId: string;
  projectId?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const body =
    params.requestBody &&
    typeof params.requestBody === "object" &&
    !Array.isArray(params.requestBody)
      ? (params.requestBody as Record<string, unknown>)
      : {};

  const requestBody = {
    ...body,
    ...(typeof body.session_id === "string" && body.session_id.trim()
      ? {}
      : params.sessionId
        ? { session_id: params.sessionId }
        : {}),
  };

  return {
    model: params.modelId,
    ...(params.projectId ? { project: params.projectId } : {}),
    user_prompt_id: crypto.randomUUID(),
    request: requestBody,
  };
}

function shouldRetryGeminiCodeAssist(response: Response, body: string): boolean {
  if (response.status !== 500) {
    return false;
  }
  const normalized = body.toLowerCase();
  return (
    normalized.includes("internal error encountered") || normalized.includes("\"status\": \"internal\"")
  );
}

function buildGeminiCodeAssistFallbackBodies(requestBody: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pushUnique = (value: Record<string, unknown>) => {
    const signature = JSON.stringify(value);
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push(value);
    }
  };

  if ("toolConfig" in requestBody) {
    const withoutToolConfig = { ...requestBody };
    delete withoutToolConfig.toolConfig;
    pushUnique(withoutToolConfig);
  }

  if ("tools" in requestBody || "toolConfig" in requestBody) {
    const withoutTools = { ...requestBody };
    delete withoutTools.toolConfig;
    delete withoutTools.tools;
    pushUnique(withoutTools);
  }

  if (
    "generationConfig" in requestBody ||
    "safetySettings" in requestBody ||
    "labels" in requestBody ||
    "cachedContent" in requestBody
  ) {
    const reducedConfig = { ...requestBody };
    delete reducedConfig.generationConfig;
    delete reducedConfig.safetySettings;
    delete reducedConfig.labels;
    delete reducedConfig.cachedContent;
    pushUnique(reducedConfig);
  }

  const minimal: Record<string, unknown> = {};
  if ("contents" in requestBody) {
    minimal.contents = requestBody.contents;
  }
  if ("systemInstruction" in requestBody) {
    minimal.systemInstruction = requestBody.systemInstruction;
  }
  if (Object.keys(minimal).length > 0) {
    pushUnique(minimal);
  }

  return candidates;
}

function logGeminiCodeAssistAttemptFailure(params: {
  status: number;
  stage: string;
  method: "generateContent" | "streamGenerateContent";
  modelId: string;
  hasProject: boolean;
  body: string;
}): void {
  if (params.status !== 500) {
    return;
  }
  const condensedBody = params.body.replace(/\s+/g, " ").trim().slice(0, 220);
  console.warn(
    `[gemini-cli] Code Assist ${params.method} failed at stage=${params.stage} ` +
      `model=${params.modelId} project=${params.hasProject ? "set" : "missing"} ` +
      `status=${params.status} body=${condensedBody}`
  );
}

function unwrapGeminiCodeAssistResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const response = record.response;
  if (response !== undefined) {
    return response;
  }

  return payload;
}

function rewriteGeminiCodeAssistEventData(rawData: string): string {
  const trimmed = rawData.trim();
  if (!trimmed || trimmed === "[DONE]") {
    return rawData;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const unwrapped = unwrapGeminiCodeAssistResponse(parsed);
    return JSON.stringify(unwrapped);
  } catch {
    return rawData;
  }
}

function rewriteGeminiCodeAssistSseStream(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let pendingLine = "";
      let eventDataLines: string[] = [];

      const flushEvent = () => {
        if (eventDataLines.length === 0) {
          return;
        }

        const data = eventDataLines.join("\n");
        eventDataLines = [];
        controller.enqueue(
          encoder.encode(`data: ${rewriteGeminiCodeAssistEventData(data)}\n\n`)
        );
      };

      const processLine = (rawLine: string) => {
        let line = rawLine;
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        if (line.startsWith("data:")) {
          eventDataLines.push(line.slice(5).trimStart());
          return;
        }

        if (line.length === 0) {
          flushEvent();
          return;
        }

        controller.enqueue(encoder.encode(`${line}\n`));
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          pendingLine += decoder.decode(value, { stream: true });
          while (true) {
            const newlineIdx = pendingLine.indexOf("\n");
            if (newlineIdx === -1) {
              break;
            }
            const line = pendingLine.slice(0, newlineIdx);
            pendingLine = pendingLine.slice(newlineIdx + 1);
            processLine(line);
          }
        }

        pendingLine += decoder.decode();
        if (pendingLine.length > 0) {
          processLine(pendingLine);
        }
        flushEvent();
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function createGeminiOauthFetch(accessToken: string) {
  const apiClient = `gl-node/${process.versions.node}`;
  const sessionId =
    geminiSessionIdCache.get(accessToken) || (() => {
      const value = crypto.randomUUID();
      geminiSessionIdCache.set(accessToken, value);
      return value;
    })();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete("x-goog-api-key");
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("x-goog-api-client", apiClient);
    headers.set("user-agent", GEMINI_CODE_ASSIST_USER_AGENT);

    if (request.method.toUpperCase() !== "POST") {
      return fetch(new Request(request, { headers }));
    }

    const requestUrl = new URL(request.url);
    const parsed = parseGeminiModelMethod(requestUrl.pathname);
    if (!parsed) {
      return fetch(new Request(request, { headers }));
    }

    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return fetch(new Request(request, { headers }));
    }

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(rawBody) as unknown;
    } catch {
      return fetch(
        new Request(request, {
          headers,
          body: rawBody,
        })
      );
    }

    const endpoint = normalizeEndpoint(`${requestUrl.protocol}//${requestUrl.host}`);
    const projectId = await resolveGeminiCodeAssistProjectId({
      accessToken,
      apiClient,
      preferredEndpoint: endpoint,
    });
    const sanitizedRequestBody = sanitizeGeminiCodeAssistRequest(requestBody);
    const targetUrl = `${endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}:${parsed.method}${
      parsed.method === "streamGenerateContent" ? "?alt=sse" : ""
    }`;
    const postCodeAssist = async (innerRequest: Record<string, unknown>) => {
      const wrappedBody = buildGeminiCodeAssistRequestBody({
        requestBody: innerRequest,
        modelId: parsed.modelId,
        projectId,
        sessionId,
      });
      return fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(wrappedBody),
        signal: request.signal,
      });
    };

    let response = await postCodeAssist(sanitizedRequestBody);
    if (!response.ok) {
      const firstErrorText = await response.clone().text().catch(() => "");
      logGeminiCodeAssistAttemptFailure({
        status: response.status,
        stage: "initial",
        method: parsed.method,
        modelId: parsed.modelId,
        hasProject: typeof projectId === "string" && projectId.length > 0,
        body: firstErrorText,
      });
      if (shouldRetryGeminiCodeAssist(response, firstErrorText)) {
        const fallbacks = buildGeminiCodeAssistFallbackBodies(sanitizedRequestBody);
        for (let i = 0; i < fallbacks.length; i += 1) {
          const fallbackRequest = fallbacks[i];
          const retryResponse = await postCodeAssist(fallbackRequest);
          if (retryResponse.ok) {
            response = retryResponse;
            break;
          }
          response = retryResponse;
          const retryErrorText = await retryResponse.clone().text().catch(() => "");
          logGeminiCodeAssistAttemptFailure({
            status: retryResponse.status,
            stage: `fallback-${i + 1}`,
            method: parsed.method,
            modelId: parsed.modelId,
            hasProject: typeof projectId === "string" && projectId.length > 0,
            body: retryErrorText,
          });
          if (!shouldRetryGeminiCodeAssist(retryResponse, retryErrorText)) {
            break;
          }
        }
      }
    }

    if (!response.ok) {
      return response;
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");

    if (parsed.method === "streamGenerateContent") {
      if (!response.body) {
        return response;
      }
      return new Response(rewriteGeminiCodeAssistSseStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const responseText = await response.text();
    if (!responseText.trim()) {
      return new Response(responseText, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    try {
      const parsedResponse = JSON.parse(responseText) as unknown;
      return new Response(
        JSON.stringify(unwrapGeminiCodeAssistResponse(parsedResponse)),
        {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        }
      );
    } catch {
      return new Response(responseText, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
  };
}

function createCodexNativeOauthModel(config: ModelConfig): LanguageModel {
  const credential = resolveCliOAuthCredentialSync("codex-cli");
  const baseURL =
    normalizeBaseUrl(config.baseUrl, {
      providerName: "codex-cli",
      fallbackBaseUrl: CODEX_BACKEND_BASE_URL,
      defaultPath: "/backend-api/codex",
    }) ?? CODEX_BACKEND_BASE_URL;
  const sanitizedBaseURL = baseURL.replace(/\/responses\/?$/, "");
  const provider = createOpenAI({
    apiKey: credential.accessToken,
    baseURL: sanitizedBaseURL,
    headers: credential.accountId
      ? {
          "ChatGPT-Account-Id": credential.accountId,
        }
      : undefined,
    fetch: createCodexOauthFetch(credential),
    name: "openai-codex",
  });
  const modelId = config.model || "gpt-5.3-codex";
  return provider.responses(modelId);
}

function createGeminiNativeOauthModel(config: ModelConfig): LanguageModel {
  const credential = resolveCliOAuthCredentialSync("gemini-cli");
  const metadata = JSON.stringify({
    ideType: "ANTIGRAVITY",
    platform: resolveGeminiCodeAssistPlatform(),
    pluginType: "GEMINI",
  });
  const baseURL =
    normalizeBaseUrl(config.baseUrl, {
      providerName: "gemini-cli",
      fallbackBaseUrl: GEMINI_CODE_ASSIST_BASE_URL,
      defaultPath: "/v1beta",
    }) ?? GEMINI_CODE_ASSIST_BASE_URL;
  const provider = createGoogleGenerativeAI({
    apiKey: "__oauth__",
    baseURL,
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "X-Goog-Api-Client": `gl-node/${process.versions.node}`,
      "Client-Metadata": metadata,
    },
    fetch: createGeminiOauthFetch(credential.accessToken),
    name: "google-gemini-cli",
  });
  const modelId = config.model || "gemini-2.5-pro";
  return provider(modelId);
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function normalizeBaseUrl(rawBaseUrl: string | undefined, settings: {
  providerName: string;
  fallbackBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultPath?: string;
}): string | undefined {
  const rawValue = (rawBaseUrl || settings.fallbackBaseUrl || "").trim();

  if (!rawValue) {
    if (settings.baseUrlRequired) {
      throw new Error(
        `${settings.providerName}: baseUrl is required. Example: https://api.example.com/v1`
      );
    }
    return undefined;
  }

  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue);
  const withScheme = hasScheme
    ? rawValue
    : `${LOCAL_HOSTNAMES.has(rawValue.split("/")[0] || "") ? "http" : "https"}://${rawValue}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(
      `${settings.providerName}: invalid baseUrl "${rawValue}". Use absolute URL, e.g. https://api.example.com/v1`
    );
  }

  if (settings.defaultPath && (parsed.pathname === "" || parsed.pathname === "/")) {
    parsed.pathname = settings.defaultPath;
  }

  return parsed.toString().replace(/\/$/, "");
}

function normalizeOpenAICompatibleApiBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return baseUrl;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return baseUrl;
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  const withoutEndpoint = trimmedPath.replace(
    /\/(chat\/completions|completions|responses|embeddings|models)$/i,
    ""
  );

  if (!withoutEndpoint) {
    parsed.pathname = "/v1";
  } else {
    parsed.pathname = withoutEndpoint;
  }

  return parsed.toString().replace(/\/$/, "");
}

function createOpenAICompatibleFetch(dropAuthorization: boolean) {
  if (!dropAuthorization) {
    return undefined;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    return fetch(new Request(request, { headers }));
  };
}

function createOpenAICompatibleChatModel(
  config: ModelConfig,
  settings: OpenAICompatibleSettings
): LanguageModel {
  const baseURL = normalizeOpenAICompatibleApiBaseUrl(
    normalizeBaseUrl(config.baseUrl, settings)
  );
  const dropAuthorization = settings.allowMissingApiKey === true && !settings.apiKey.trim();
  const provider = createOpenAI({
    apiKey: settings.apiKey || "__no_api_key__",
    baseURL,
    name: settings.providerName,
    fetch: createOpenAICompatibleFetch(dropAuthorization),
  });
  return provider.chat(config.model);
}

function createOpenAICompatibleEmbeddingModel(config: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}, settings: OpenAICompatibleSettings) {
  const baseURL = normalizeOpenAICompatibleApiBaseUrl(
    normalizeBaseUrl(config.baseUrl, settings)
  );
  const dropAuthorization = settings.allowMissingApiKey === true && !settings.apiKey.trim();
  const provider = createOpenAI({
    apiKey: settings.apiKey || "__no_api_key__",
    baseURL,
    name: settings.providerName,
    fetch: createOpenAICompatibleFetch(dropAuthorization),
  });
  return provider.embedding(config.model);
}

/**
 * Create an AI SDK language model from our ModelConfig
 */
export function createModel(
  config: ModelConfig,
  runtime?: ModelRuntimeContext
): LanguageModel {
  switch (config.provider) {
    case "openai": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "openai",
        apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
      });
    }

    case "anthropic": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "anthropic",
        fallbackBaseUrl: "https://api.anthropic.com",
        defaultPath: "/v1",
      });
      const anthropic = createAnthropic({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
        baseURL,
      });
      return anthropic(config.model);
    }

    case "google": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "google",
        fallbackBaseUrl: "https://generativelanguage.googleapis.com",
        defaultPath: "/v1beta",
      });
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey || process.env.GOOGLE_API_KEY || "",
        baseURL,
      });
      return google(config.model);
    }

    case "openrouter": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "openrouter",
        apiKey: config.apiKey || process.env.OPENROUTER_API_KEY || "",
        fallbackBaseUrl: "https://openrouter.ai/api/v1",
      });
    }

    case "ollama": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "ollama",
        apiKey: "ollama",
        fallbackBaseUrl: "http://localhost:11434",
        defaultPath: "/v1",
      });
    }

    case "custom": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "custom",
        apiKey: config.apiKey || "",
        allowMissingApiKey: true,
        baseUrlRequired: true,
        defaultPath: "/v1",
      });
    }

    case "codex-cli": {
      try {
        return createCodexNativeOauthModel(config);
      } catch (cause) {
        if (ENABLE_SUBPROCESS_CLI_FALLBACK) {
          return createCliLanguageModel("codex-cli", config, runtime);
        }
        throw new Error(
          `Codex OAuth transport is not ready: ${describeError(cause)}`
        );
      }
    }

    case "gemini-cli": {
      try {
        return createGeminiNativeOauthModel(config);
      } catch (cause) {
        if (ENABLE_SUBPROCESS_CLI_FALLBACK) {
          return createCliLanguageModel("gemini-cli", config, runtime);
        }
        throw new Error(
          `Gemini OAuth transport is not ready: ${describeError(cause)}`
        );
      }
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create an embeddings model.
 */
export function createEmbeddingModel(config: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  switch (config.provider) {
    case "openai":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "openai",
        apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
      });

    case "openrouter":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "openrouter",
        apiKey: config.apiKey || process.env.OPENROUTER_API_KEY || "",
        fallbackBaseUrl: "https://openrouter.ai/api/v1",
      });

    case "ollama":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "ollama",
        apiKey: "ollama",
        fallbackBaseUrl: "http://localhost:11434",
        defaultPath: "/v1",
      });

    case "custom":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "custom",
        apiKey: config.apiKey || "",
        allowMissingApiKey: true,
        baseUrlRequired: true,
        defaultPath: "/v1",
      });

    case "google": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "google",
        fallbackBaseUrl: "https://generativelanguage.googleapis.com",
        defaultPath: "/v1beta",
      });
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey || process.env.GOOGLE_API_KEY || "",
        baseURL,
      });
      return google.embedding(config.model);
    }

    default:
      throw new Error(`Unsupported embeddings provider: ${config.provider}`);
  }
}
