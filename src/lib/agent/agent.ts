import {
  streamText,
  generateText,
  stepCountIs,
  type ModelMessage,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import { buildSystemPrompt } from "@/lib/agent/prompts";
import { getSettings } from "@/lib/storage/settings-store";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { createAgentTools } from "@/lib/tools/tool";
import { getProjectMcpTools } from "@/lib/mcp/client";
import type { AgentContext } from "@/lib/agent/types";
import type { ChatMessage } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

const LLM_LOG_BORDER = "═".repeat(60);

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

function extractDeterministicFailureSignature(output: unknown): string | null {
  const outputRecord = asRecord(output);
  if (outputRecord && outputRecord.success === false) {
    const errorText =
      typeof outputRecord.error === "string"
        ? outputRecord.error
        : "Tool returned success=false";
    const codeText = typeof outputRecord.code === "string" ? outputRecord.code : "";
    return [errorText, codeText].filter(Boolean).join(" | ");
  }

  if (typeof output !== "string") {
    return null;
  }

  const trimmed = output.trim();
  const parsed = parseJsonObject(trimmed);
  if (parsed && parsed.success === false) {
    const errorText =
      typeof parsed.error === "string" ? parsed.error : "Tool returned success=false";
    const codeText = typeof parsed.code === "string" ? parsed.code : "";
    return [errorText, codeText].filter(Boolean).join(" | ");
  }

  const isExplicitFailure =
    trimmed.startsWith("[MCP tool error]") ||
    trimmed.startsWith("[Preflight error]") ||
    trimmed.startsWith("[Loop guard]") ||
    /^Failed\b/i.test(trimmed) ||
    /^Skill ".+" not found\./i.test(trimmed) ||
    (/\bnot found\b/i.test(trimmed) &&
      !/No relevant memories found\./i.test(trimmed));

  if (!isExplicitFailure) {
    return null;
  }

  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

function applyGlobalToolLoopGuard(tools: ToolSet): ToolSet {
  const deterministicFailureByCall = new Map<string, string>();
  const wrappedTools: ToolSet = {};

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (toolName === "response" || typeof toolDef.execute !== "function") {
      wrappedTools[toolName] = toolDef;
      continue;
    }

    wrappedTools[toolName] = {
      ...toolDef,
      execute: async (input: unknown, options: ToolExecutionOptions) => {
        const callKey = `${toolName}:${stableSerialize(input)}`;
        const previousFailure = deterministicFailureByCall.get(callKey);
        if (previousFailure) {
          return (
            `[Loop guard] Blocked repeated tool call "${toolName}" with identical arguments.\n` +
            `Previous deterministic error: ${previousFailure}\n` +
            "Change arguments based on the tool error before retrying."
          );
        }

        const output = await toolDef.execute(input as never, options as never);
        const failureSignature = extractDeterministicFailureSignature(output);
        if (failureSignature) {
          deterministicFailureByCall.set(callKey, failureSignature);
        } else {
          deterministicFailureByCall.delete(callKey);
        }
        return output;
      },
    } as typeof toolDef;
  }

  return wrappedTools;
}

/**
 * Convert stored ChatMessages to AI SDK ModelMessage format
 */
function convertChatMessagesToModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === "tool") {
      // Tool result message - AI SDK uses 'output' not 'result'
      result.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.toolCallId!,
          toolName: m.toolName!,
          output: { type: "json", value: m.toolResult as import("@ai-sdk/provider").JSONValue },
        }],
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant message with tool calls - AI SDK uses 'input' not 'args'
      const content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.args,
        });
      }
      result.push({ role: "assistant", content });
    } else if (m.role === "user" || m.role === "assistant") {
      // Regular user or assistant message
      result.push({ role: m.role, content: m.content });
    }
    // Skip system messages for now
  }

  return result;
}

/**
 * Convert AI SDK ModelMessage to our ChatMessage format for storage.
 * Tool messages can contain multiple tool results, so this returns an array.
 */
function convertModelMessageToChatMessages(msg: ModelMessage, now: string): ChatMessage[] {
  if (msg.role === "tool") {
    // Tool result - AI SDK may include multiple tool-result parts in one message.
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolMessages: ChatMessage[] = [];

    for (const part of content) {
      if (!(typeof part === "object" && part !== null && "type" in part && part.type === "tool-result")) {
        continue;
      }

      const tr = part as {
        toolCallId: string;
        toolName: string;
        output?: { type: string; value: unknown } | unknown;
        result?: unknown;
      };

      const outputContainer = tr.output ?? tr.result;
      const outputValue =
        typeof outputContainer === "object" &&
        outputContainer !== null &&
        "value" in outputContainer
          ? (outputContainer as { value: unknown }).value
          : outputContainer;

      toolMessages.push({
        id: crypto.randomUUID(),
        role: "tool",
        content:
          outputValue === undefined
            ? ""
            : typeof outputValue === "string"
              ? outputValue
              : JSON.stringify(outputValue),
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        toolResult: outputValue,
        createdAt: now,
      });
    }

    return toolMessages;
  }

  if (msg.role === "assistant") {
    const content = msg.content;
    if (Array.isArray(content)) {
      // Extract text and tool calls - AI SDK uses 'input' not 'args'
      let textContent = "";
      const toolCalls: ChatMessage["toolCalls"] = [];

      for (const part of content) {
        if (typeof part === "object" && part !== null) {
          if ("type" in part && part.type === "text" && "text" in part) {
            textContent += (part as { text: string }).text;
          } else if ("type" in part && part.type === "tool-call") {
            const tc = part as { toolCallId: string; toolName: string; input: unknown };
            toolCalls.push({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.input as Record<string, unknown>,
            });
          }
        }
      }

      return [{
        id: crypto.randomUUID(),
        role: "assistant",
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        createdAt: now,
      }];
    }
    // String content
    return [{
      id: crypto.randomUUID(),
      role: "assistant",
      content: typeof content === "string" ? content : "",
      createdAt: now,
    }];
  }

  // User or other
  return [{
    id: crypto.randomUUID(),
    role: msg.role as "user" | "assistant" | "system" | "tool",
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    createdAt: now,
  }];
}

function logLLMRequest(options: {
  model: string;
  system: string;
  messages: ModelMessage[];
  toolNames: string[];
  temperature?: number;
  maxTokens?: number;
  label?: string;
}) {
  const { model, system, messages, toolNames, temperature, maxTokens, label = "LLM Request" } = options;
  console.log(`\n${LLM_LOG_BORDER}`);
  console.log(`  ${label}`);
  console.log(LLM_LOG_BORDER);
  console.log(`  Model: ${model}`);
  console.log(`  Temperature: ${temperature ?? "default"}`);
  console.log(`  Max tokens: ${maxTokens ?? "default"}`);
  console.log(`  Tools: ${toolNames.length ? toolNames.join(", ") : "none"}`);
  console.log(`  Messages: ${messages.length}`);
  console.log(LLM_LOG_BORDER);
  console.log("  --- SYSTEM ---\n");
  console.log(system);
  console.log("\n  --- MESSAGES ---");
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role.toUpperCase();
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const preview = content.length > 500 ? content.slice(0, 500) + "…" : content;
    console.log(`  [${i + 1}] ${role}:\n${preview}`);
  }
  console.log(`\n${LLM_LOG_BORDER}\n`);
}

/**
 * Run the agent for a given chat context and return a streamable result.
 * Uses Vercel AI SDK's streamText with stopWhen for automatic tool loop.
 */
export async function runAgent(options: {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  agentNumber?: number;
}) {
  const settings = await getSettings();
  const model = createModel(settings.chatModel);

  // Build context
  const context: AgentContext = {
    chatId: options.chatId,
    projectId: options.projectId,
    currentPath: options.currentPath,
    memorySubdir: options.projectId
      ? `${options.projectId}`
      : "main",
    knowledgeSubdirs: options.projectId
      ? [`${options.projectId}`, "main"]
      : ["main"],
    history: [],
    agentNumber: options.agentNumber ?? 0,
    data: {
      currentUserMessage: options.userMessage,
    },
  };

  // Load existing chat history
  const chat = await getChat(options.chatId);
  if (chat) {
    // Convert stored messages to ModelMessage format (including tool calls/results)
    context.history = convertChatMessagesToModelMessages(chat.messages);
  }

  // Build tools: base + optional MCP tools from project .meta/mcp
  const baseTools = createAgentTools(context, settings);
  let mcpCleanup: (() => Promise<void>) | undefined;
  let tools = baseTools;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
  const toolNames = Object.keys(tools);

  // Build system prompt
  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

  // Append user message to history
  const messages: ModelMessage[] = [
    ...context.history,
    { role: "user", content: options.userMessage },
  ];

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (stream)",
  });

  // Run the agent with streaming
  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(15), // Allow up to 15 tool call rounds
    temperature: settings.chatModel.temperature ?? 0.7,
    maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
    onFinish: async (event) => {
      if (mcpCleanup) {
        try {
          await mcpCleanup();
        } catch {
          // non-critical
        }
      }
      // Save to chat history (including tool calls and results)
      try {
        const chat = await getChat(options.chatId);
        if (chat) {
          const now = new Date().toISOString();

          // Add user message
          chat.messages.push({
            id: crypto.randomUUID(),
            role: "user",
            content: options.userMessage,
            createdAt: now,
          });

          // Add all response messages (assistant + tool calls + tool results)
          const responseMessages = event.response.messages;
          for (const msg of responseMessages) {
            chat.messages.push(...convertModelMessageToChatMessages(msg, now));
          }

          chat.updatedAt = now;
          // Auto-title from first user message (count user messages, not total)
          const userMessageCount = chat.messages.filter(m => m.role === "user").length;
          if (userMessageCount === 1 && chat.title === "New Chat") {
            chat.title =
              options.userMessage.slice(0, 60) +
              (options.userMessage.length > 60 ? "..." : "");
          }
          await saveChat(chat);
        }
      } catch {
        // Non-critical, don't fail the response
      }

      publishUiSyncEvent({
        topic: "files",
        projectId: options.projectId ?? null,
        reason: "agent_turn_finished",
      });
    },
  });

  return result;
}

/**
 * Non-streaming agent turn for background tasks (cron/scheduler).
 */
export async function runAgentText(options: {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  agentNumber?: number;
  runtimeData?: Record<string, unknown>;
}): Promise<string> {
  const settings = await getSettings();
  const model = createModel(settings.chatModel);

  const context: AgentContext = {
    chatId: options.chatId,
    projectId: options.projectId,
    currentPath: options.currentPath,
    memorySubdir: options.projectId ? `${options.projectId}` : "main",
    knowledgeSubdirs: options.projectId ? [`${options.projectId}`, "main"] : ["main"],
    history: [],
    agentNumber: options.agentNumber ?? 0,
    data: {
      ...(options.runtimeData ?? {}),
      currentUserMessage: options.userMessage,
    },
  };

  const chat = await getChat(options.chatId);
  if (chat) {
    context.history = convertChatMessagesToModelMessages(chat.messages);
  }

  const baseTools = createAgentTools(context, settings);
  let mcpCleanup: (() => Promise<void>) | undefined;
  let tools = baseTools;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
  const toolNames = Object.keys(tools);

  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

  const messages: ModelMessage[] = [
    ...context.history,
    { role: "user", content: options.userMessage },
  ];

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (non-stream)",
  });

  try {
    const generated = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(15),
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
    });

    const text = generated.text ?? "";

    try {
      const latest = await getChat(options.chatId);
      if (latest) {
        const now = new Date().toISOString();
        latest.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          content: options.userMessage,
          createdAt: now,
        });

        const responseMessages = (
          generated as unknown as { response?: { messages?: ModelMessage[] } }
        ).response?.messages;

        if (Array.isArray(responseMessages) && responseMessages.length > 0) {
          for (const msg of responseMessages) {
            latest.messages.push(...convertModelMessageToChatMessages(msg, now));
          }
        } else {
          latest.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: text,
            createdAt: now,
          });
        }

        latest.updatedAt = now;
        await saveChat(latest);
      }
    } catch {
      // Non-critical for background runs.
    }

    publishUiSyncEvent({
      topic: "files",
      projectId: options.projectId ?? null,
      reason: "agent_turn_finished",
    });

    return text;
  } finally {
    if (mcpCleanup) {
      try {
        await mcpCleanup();
      } catch {
        // non-critical
      }
    }
  }
}

/**
 * Run agent for subordinate delegation (non-streaming, returns result)
 */
export async function runSubordinateAgent(options: {
  task: string;
  projectId?: string;
  parentAgentNumber: number;
  parentHistory: ModelMessage[];
}): Promise<string> {
  const settings = await getSettings();
  const model = createModel(settings.chatModel);

  const context: AgentContext = {
    chatId: `subordinate-${Date.now()}`,
    projectId: options.projectId,
    memorySubdir: options.projectId
      ? `projects/${options.projectId}`
      : "main",
    knowledgeSubdirs: options.projectId
      ? [`projects/${options.projectId}`, "main"]
      : ["main"],
    history: [],
    agentNumber: options.parentAgentNumber + 1,
    data: {},
  };

  let tools = createAgentTools(context, settings);
  let mcpCleanupSub: (() => Promise<void>) | undefined;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...tools, ...mcp.tools };
      mcpCleanupSub = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
  const toolNames = Object.keys(tools);

  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    agentNumber: context.agentNumber,
    tools: toolNames,
  });

  // Include relevant parent history for context
  const relevantHistory = options.parentHistory.slice(-6);

  const messages: ModelMessage[] = [
    ...relevantHistory,
    {
      role: "user",
      content: `You are a subordinate agent. Complete this task and report back:\n\n${options.task}`,
    },
  ];

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (subordinate)",
  });

  try {
    const { text } = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(10),
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
    });
    return text;
  } finally {
    if (mcpCleanupSub) {
      try {
        await mcpCleanupSub();
      } catch {
        // non-critical
      }
    }
  }
}
