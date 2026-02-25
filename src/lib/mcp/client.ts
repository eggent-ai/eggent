/**
 * MCP (Model Context Protocol) client integration.
 * Connects to project-configured MCP servers via STDIO or HTTP and exposes their tools to the agent.
 * @see https://modelcontextprotocol.io/docs/learn/architecture
 */

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import type { McpServerConfig } from "@/lib/types";
import type { ToolSet, ToolExecutionOptions } from "ai";
import { dynamicTool } from "ai";
import { z } from "zod";

const MCP_CLIENT_NAME = "eggent";
const MCP_CLIENT_VERSION = "1.0.0";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStableValue(item));
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = toStableValue(record[key]);
      return acc;
    }, {});
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(toStableValue(value));
  } catch {
    return String(value);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function isN8nWorkflowTool(toolName: string): boolean {
  return toolName.includes("n8n") && toolName.includes("workflow");
}

function isN8nWorkflowCreateTool(toolName: string): boolean {
  return isN8nWorkflowTool(toolName) && toolName.includes("create");
}

function isN8nWorkflowUpdateTool(toolName: string): boolean {
  return isN8nWorkflowTool(toolName) && toolName.includes("update");
}

function normalizeN8nConnectionsShape(connections: unknown): {
  changed: boolean;
  value: unknown;
} {
  const connectionsRecord = asRecord(connections);
  if (!connectionsRecord) {
    return { changed: false, value: connections };
  }

  let changed = false;
  const normalizedConnections: Record<string, unknown> = {};

  for (const [sourceNode, sourceValue] of Object.entries(connectionsRecord)) {
    const sourceRecord = asRecord(sourceValue);
    if (!sourceRecord) {
      normalizedConnections[sourceNode] = sourceValue;
      continue;
    }

    const normalizedSource: Record<string, unknown> = { ...sourceRecord };
    const main = sourceRecord.main;

    if (Array.isArray(main)) {
      const normalizedMain = main.map((slot) => {
        if (Array.isArray(slot)) {
          return slot;
        }
        const slotRecord = asRecord(slot);
        if (slotRecord && "node" in slotRecord) {
          changed = true;
          return [slotRecord];
        }
        return slot;
      });
      if (stableSerialize(main) !== stableSerialize(normalizedMain)) {
        changed = true;
      }
      normalizedSource.main = normalizedMain;
    } else {
      const mainRecord = asRecord(main);
      if (mainRecord && "node" in mainRecord) {
        normalizedSource.main = [[mainRecord]];
        changed = true;
      }
    }

    normalizedConnections[sourceNode] = normalizedSource;
  }

  return changed
    ? { changed: true, value: normalizedConnections }
    : { changed: false, value: connections };
}

function preprocessMcpArgs(
  toolName: string,
  args: Record<string, unknown>,
  knownN8nWorkflowIds: Set<string>
): { args: Record<string, unknown>; notes: string[]; preflightError?: string } {
  const nextArgs: Record<string, unknown> = { ...args };
  const notes: string[] = [];

  if (!isN8nWorkflowTool(toolName)) {
    return { args: nextArgs, notes };
  }

  if ("connections" in nextArgs) {
    const normalized = normalizeN8nConnectionsShape(nextArgs.connections);
    if (normalized.changed) {
      nextArgs.connections = normalized.value;
      notes.push("Normalized n8n `connections.main` to nested array format.");
    }
  }

  if (isN8nWorkflowUpdateTool(toolName)) {
    const id = nextArgs.id;
    const isValidId =
      (typeof id === "string" && id.trim().length > 0) || typeof id === "number";

    if (!isValidId) {
      return {
        args: nextArgs,
        notes,
        preflightError:
          "[Preflight error] Missing workflow `id` for n8n update operation. " +
          "Use the `id` returned by a successful create/get workflow call; do not guess IDs.",
      };
    }

    const idText = String(id);
    if (knownN8nWorkflowIds.size > 0 && !knownN8nWorkflowIds.has(idText)) {
      notes.push(
        `Workflow id "${idText}" was not observed in this session; verify it before updating.`
      );
    }
  }

  return { args: nextArgs, notes };
}

function extractDeterministicErrorSignature(output: string): string | null {
  const parsed = parseJsonObject(output);
  if (!parsed || parsed.success !== false) {
    return null;
  }

  const errorText =
    typeof parsed.error === "string"
      ? parsed.error
      : "MCP tool returned success=false";

  const details = asRecord(parsed.details);
  const detailsErrors = details?.errors;
  const detailText = Array.isArray(detailsErrors)
    ? detailsErrors
      .slice(0, 2)
      .map((item) => (typeof item === "string" ? item : stableSerialize(item)))
      .join(" | ")
    : "";

  const codeText = typeof parsed.code === "string" ? parsed.code : "";
  return [errorText, detailText, codeText].filter(Boolean).join(" | ");
}

function extractWorkflowIdFromSuccess(output: string): string | null {
  const parsed = parseJsonObject(output);
  if (!parsed || parsed.success === false) {
    return null;
  }

  const direct =
    typeof parsed.id === "string" || typeof parsed.id === "number"
      ? String(parsed.id)
      : null;
  if (direct) return direct;

  const data = asRecord(parsed.data);
  if (data && (typeof data.id === "string" || typeof data.id === "number")) {
    return String(data.id);
  }

  const workflow = asRecord(parsed.workflow);
  if (
    workflow &&
    (typeof workflow.id === "string" || typeof workflow.id === "number")
  ) {
    return String(workflow.id);
  }

  return null;
}

function buildN8nFailureHint(output: string): string | null {
  if (!output.includes("Expected array, received object")) {
    return null;
  }
  return "For n8n, `connections.<source>.main` must be an array of arrays: " +
    '`"main": [[{"node":"Target","type":"main","index":0}]]`.';
}

export interface McpConnection {
  serverId: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

export interface McpToolMeta {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; items?: { type?: string }; enum?: unknown[] }>;
    required?: string[];
  };
}

/**
 * Build a Zod schema from MCP tool's JSON Schema so the model and provider see real parameters (url, etc.).
 * Falls back to generic { arguments: record } if conversion is not possible.
 */
function mcpInputSchemaToZod(meta: McpToolMeta): z.ZodType<Record<string, unknown>> {
  const schema = meta.inputSchema;
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];

  if (!properties || Object.keys(properties).length === 0) {
    return z.object({
      arguments: z.record(z.string(), z.unknown()).optional().describe("No arguments required; pass {} or omit."),
    }) as z.ZodType<Record<string, unknown>>;
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") {
      shape[key] = z.unknown().optional();
      continue;
    }
    const desc = typeof prop.description === "string" ? prop.description : undefined;
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case "string":
        field = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(prop.items?.type === "string" ? z.string() : z.unknown());
        break;
      case "object":
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.unknown();
    }
    if (desc) field = field.describe(desc);
    if (!required.includes(key)) field = field.optional();
    shape[key] = field;
  }

  return z.object(shape) as z.ZodType<Record<string, unknown>>;
}

/**
 * Create transport for one MCP server (stdio or http).
 */
function createTransport(
  config: McpServerConfig
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      cwd: config.cwd,
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

/**
 * Connect to one MCP server and return client + transport.
 */
export async function connectMcpServer(
  config: McpServerConfig
): Promise<McpConnection | null> {
  try {
    const transport = createTransport(config);
    const client = new Client(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      {}
    );
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    return { serverId: config.id, client, transport };
  } catch (err) {
    console.error(`[MCP] Failed to connect to server "${config.id}":`, err);
    return null;
  }
}

/**
 * List tools from a connected MCP client.
 */
export async function listMcpTools(
  client: Client
): Promise<{ name: string; description?: string; inputSchema?: McpToolMeta["inputSchema"] }[]> {
  try {
    const result = await client.listTools();
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpToolMeta["inputSchema"],
    }));
  } catch {
    return [];
  }
}

/**
 * Call one MCP tool and return text result for the agent.
 */
export async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const rawContent = result.content;
    const contentList = Array.isArray(rawContent) ? rawContent : rawContent != null ? [rawContent] : [];
    const parts: string[] = [];
    for (const item of contentList) {
      if (item.type === "text") {
        parts.push(item.text);
      } else if (item.type === "resource_link") {
        parts.push(`[Resource: ${item.name}] ${item.uri}`);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join("\n") || "(no output)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[MCP tool error] ${msg}`;
  }
}

/**
 * Close transport (stdio process or HTTP session).
 */
export async function closeMcpConnection(conn: McpConnection): Promise<void> {
  try {
    if ("close" in conn.transport && typeof conn.transport.close === "function") {
      await conn.transport.close();
    }
  } catch (err) {
    console.error(`[MCP] Error closing server "${conn.serverId}":`, err);
  }
}

/**
 * Load project MCP config, connect to all servers, list tools, and build agent ToolSet + cleanup.
 * Tool names are prefixed: mcp_<serverId>_<toolName> to avoid collisions.
 */
export async function getProjectMcpTools(projectId: string): Promise<{
  tools: ToolSet;
  cleanup: () => Promise<void>;
  serverIds: string[];
} | null> {
  const { loadProjectMcpServers } = await import("@/lib/storage/project-store");
  const config = await loadProjectMcpServers(projectId);
  if (!config?.servers?.length) return null;

  const connections: McpConnection[] = [];
  const toolMetaByKey: Record<string, McpToolMeta & { conn: McpConnection }> = {};
  const deterministicFailureByCall = new Map<string, string>();
  const knownN8nWorkflowIds = new Set<string>();

  for (const server of config.servers) {
    const conn = await connectMcpServer(server);
    if (!conn) continue;
    connections.push(conn);
    const tools = await listMcpTools(conn.client);
    for (const t of tools) {
      const key = `mcp_${server.id}_${t.name}`;
      toolMetaByKey[key] = {
        serverId: server.id,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        conn,
      };
    }
  }

  if (connections.length === 0) return null;

  const tools: ToolSet = {};
  for (const [key, meta] of Object.entries(toolMetaByKey)) {
    const desc =
      meta.description ||
      `MCP tool ${meta.name} from server ${meta.serverId}.`;
    const hasParams =
      meta.inputSchema?.properties && Object.keys(meta.inputSchema.properties).length > 0;
    const requiredList = meta.inputSchema?.required ?? [];
    const paramHint = hasParams
      ? ` Parameters: ${JSON.stringify(meta.inputSchema!.properties)}. Required: ${requiredList.join(", ") || "none"}.`
      : requiredList.length === 0
        ? " No arguments required; pass {}."
        : ` Required: ${requiredList.join(", ")}.`;

    // Use real MCP tool params (url, etc.) when available so provider and model see correct schema
    const inputSchema = mcpInputSchemaToZod(meta);
    tools[key] = dynamicTool({
      description: `[MCP ${meta.serverId}] ${desc}${paramHint}`,
      inputSchema,
      execute: async (
        input: unknown,
        _options: ToolExecutionOptions
      ): Promise<string> => {
        // Support both { arguments: { url, ... } } and flat { url, ... } (e.g. from model)
        let args: Record<string, unknown> = {};
        if (input != null && typeof input === "object") {
          const obj = input as Record<string, unknown>;
          if (
            "arguments" in obj &&
            typeof obj.arguments === "object" &&
            obj.arguments !== null &&
            !Array.isArray(obj.arguments)
          ) {
            args = obj.arguments as Record<string, unknown>;
          } else {
            args = { ...obj };
          }
        }

        const preprocessed = preprocessMcpArgs(
          meta.name,
          args,
          knownN8nWorkflowIds
        );
        args = preprocessed.args;
        if (preprocessed.preflightError) {
          return preprocessed.preflightError;
        }

        const callKey = `${key}:${stableSerialize(args)}`;
        const previousFailure = deterministicFailureByCall.get(callKey);
        if (previousFailure) {
          return (
            `[Loop guard] Blocked repeated MCP call "${meta.name}" with identical arguments.\n` +
            `Previous deterministic error: ${previousFailure}\n` +
            "Change arguments based on the error details before retrying."
          );
        }

        try {
          const output = await callMcpTool(meta.conn.client, meta.name, args);
          const deterministicError = extractDeterministicErrorSignature(output);

          let decoratedOutput = output;
          if (deterministicError) {
            deterministicFailureByCall.set(callKey, deterministicError);
            const n8nHint = buildN8nFailureHint(output);
            if (n8nHint) {
              decoratedOutput += `\n\n[Hint] ${n8nHint}`;
            }
          } else {
            deterministicFailureByCall.delete(callKey);
            if (isN8nWorkflowCreateTool(meta.name)) {
              const workflowId = extractWorkflowIdFromSuccess(output);
              if (workflowId) {
                knownN8nWorkflowIds.add(workflowId);
              }
            }
          }

          if (preprocessed.notes.length > 0) {
            return `[Preflight] ${preprocessed.notes.join(" ")}\n${decoratedOutput}`;
          }

          return decoratedOutput;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `[MCP tool error] ${msg}`;
        }
      },
    });
  }

  async function cleanup() {
    for (const conn of connections) {
      await closeMcpConnection(conn);
    }
  }

  return {
    tools,
    cleanup,
    serverIds: [...new Set(connections.map((c) => c.serverId))],
  };
}
