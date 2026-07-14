"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ChatMessages } from "./chat-messages";
import { ChatInput } from "./chat-input";
import { useAppStore } from "@/store/app-store";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { ChatMessage } from "@/lib/types";
import type { PiRuntimeStats } from "@/lib/pi/types";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { generateClientId } from "@/lib/utils";

/** Convert stored ChatMessage to UIMessage (parts format for useChat) */
function isPiRuntimeStats(value: unknown): value is PiRuntimeStats {
  return typeof value === "object" && value !== null;
}

function getLatestPiRuntimeStats(messages: UIMessage[]): PiRuntimeStats | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j] as { type?: string; data?: unknown };
      if (part.type === "data-piStats" && isPiRuntimeStats(part.data)) {
        return part.data;
      }
    }
  }
  return null;
}

function chatMessagesToUIMessages(chatMessages: ChatMessage[]): UIMessage[] {
  const result: UIMessage[] = [];

  // Build a map of toolCallId -> tool result for pairing
  const toolResultMap = new Map<string, ChatMessage>();
  for (const m of chatMessages) {
    if (m.role === "tool" && m.toolCallId) {
      toolResultMap.set(m.toolCallId, m);
    }
  }

  for (const m of chatMessages) {
    if (m.role === "user") {
      result.push({
        id: m.id,
        role: "user",
        parts: [{ type: "text" as const, text: m.content }],
      });
    } else if (m.role === "assistant") {
      const parts: UIMessage["parts"] = [];

      // Add tool call parts with their results
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          const toolResult = toolResultMap.get(tc.toolCallId);
          parts.push({
            type: `tool-${tc.toolName}` as `tool-${string}`,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            state: "output-available" as const,
            input: tc.args,
            output: toolResult?.toolResult ?? toolResult?.content ?? "",
          } as unknown as UIMessage["parts"][number]);
        }
      }

      // Add text content
      if (m.content) {
        parts.push({ type: "text" as const, text: m.content });
      }

      // Keep Pi runtime stats in the message stream so the footer remains
      // populated after the live stream is replaced by stored chat history.
      if (m.piRuntimeStats) {
        parts.push({
          type: "data-piStats",
          id: `pi-stats-${m.id}`,
          data: m.piRuntimeStats,
        } as UIMessage["parts"][number]);
      }

      // Only add message if it has content
      if (parts.length > 0) {
        result.push({
          id: m.id,
          role: "assistant",
          parts,
        });
      }
    }
    // Skip "tool" role messages - they are paired with assistant toolCalls above
  }

  return result;
}

interface SwitchProjectResult {
  success?: boolean;
  action?: string;
  projectId?: string | null;
  currentPath?: string;
}

interface CreateProjectResult {
  success?: boolean;
  action?: string;
  projectId?: string;
}

function tryParseSwitchProjectResult(output: unknown): SwitchProjectResult | null {
  if (output == null) return null;

  let parsed: unknown = output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.action !== "switch_project" || record.success !== true) {
    return null;
  }

  const rawProjectId = typeof record.projectId === "string" ? record.projectId.trim() : undefined;
  if (!rawProjectId) {
    return null;
  }
  const projectId = rawProjectId === "none" ? null : rawProjectId;

  return {
    success: true,
    action: "switch_project",
    projectId,
    currentPath:
      typeof record.currentPath === "string" ? record.currentPath : undefined,
  };
}

function tryParseCreateProjectResult(output: unknown): CreateProjectResult | null {
  if (output == null) return null;

  let parsed: unknown = output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.action !== "create_project" || record.success !== true) {
    return null;
  }

  const projectId = typeof record.projectId === "string" ? record.projectId : undefined;
  if (!projectId?.trim()) {
    return null;
  }

  return {
    success: true,
    action: "create_project",
    projectId,
  };
}

function extractToolPartInfo(
  part: UIMessage["parts"][number],
  toolName: string
): { key: string; output: unknown } | null {
  if (part.type === "dynamic-tool") {
    const dynamicPart = part as {
      type: "dynamic-tool";
      toolName: string;
      toolCallId: string;
      state: string;
      output?: unknown;
    };
    if (
      dynamicPart.toolName !== toolName ||
      dynamicPart.state !== "output-available"
    ) {
      return null;
    }
    return {
      key: dynamicPart.toolCallId ? `${toolName}:${dynamicPart.toolCallId}` : "",
      output: dynamicPart.output,
    };
  }

  if (part.type === `tool-${toolName}`) {
    const toolPart = part as {
      type: string;
      toolCallId: string;
      state: string;
      output?: unknown;
    };
    if (toolPart.state !== "output-available") {
      return null;
    }
    return {
      key: toolPart.toolCallId ? `${toolName}:${toolPart.toolCallId}` : "",
      output: toolPart.output,
    };
  }

  return null;
}

function areUIMessagesEquivalentById(
  left: UIMessage[],
  right: UIMessage[]
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].id !== right[i].id) return false;
    if (left[i].role !== right[i].role) return false;
  }
  return true;
}

function formatChatErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "The model stopped before producing a final response. Please retry.";
  }
  return compact.length > 280 ? `${compact.slice(0, 280)}...` : compact;
}

function normalizeVisibleText(text: string): string {
  return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
}

function extractVisibleAssistantText(message: UIMessage): string {
  if (message.role !== "assistant") return "";

  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const normalizedText = normalizeVisibleText(text);
  if (normalizedText) return normalizedText;

  const responseToolText = message.parts
    .map((part) => {
      if (part.type === "dynamic-tool") {
        const dp = part as {
          toolName?: string;
          state?: string;
          output?: unknown;
        };
        if (dp.toolName !== "response" || dp.state !== "output-available") return "";
        return typeof dp.output === "string" ? dp.output : JSON.stringify(dp.output ?? "");
      }

      if (!part.type.startsWith("tool-")) return "";
      const tp = part as {
        type: string;
        state?: string;
        output?: unknown;
      };
      const toolName = tp.type.replace("tool-", "");
      if (toolName !== "response" || tp.state !== "output-available") return "";
      return typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output ?? "");
    })
    .filter(Boolean)
    .join("\n");

  return normalizeVisibleText(responseToolText);
}

function assistantMessageHasToolOutput(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool") {
      const dp = part as { state?: string };
      return dp.state === "output-available" || dp.state === "output-error";
    }
    if (!part.type.startsWith("tool-")) return false;
    const tp = part as { state?: string };
    return tp.state === "output-available" || tp.state === "output-error";
  });
}

const NO_FINAL_RESPONSE_FALLBACK =
  "Инструменты выполнились, но финальный ответ не получен. Напишите `continue`, и я завершу ответ.";

export function ChatPanel() {
  const {
    activeChatId,
    setActiveChatId,
    activeProjectId,
    currentPath,
    setCurrentPath,
    setActiveProjectId,
    setProjects,
    addChat,
  } = useAppStore();
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [inputFocusSignal, setInputFocusSignal] = useState(0);
  const [configuredRuntimeStats, setConfiguredRuntimeStats] = useState<PiRuntimeStats | null>(null);

  // Internal chatId that stays stable during a message send.
  // Pre-generate a UUID so useChat always has a consistent id.
  const [internalChatId, setInternalChatId] = useState(
    () => activeChatId || generateClientId()
  );
  const syncTick = useBackgroundSync({
    topics: ["chat", "global", "projects"],
    projectId: activeProjectId ?? null,
    chatId: activeChatId ?? undefined,
  });
  const internalChatIdRef = useRef(internalChatId);
  internalChatIdRef.current = internalChatId;

  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  // Track the last activeChatId we've seen to detect external navigation
  const prevActiveChatId = useRef(activeChatId);

  // Sync internalChatId when user navigates to a different chat via sidebar
  useEffect(() => {
    if (activeChatId !== prevActiveChatId.current) {
      prevActiveChatId.current = activeChatId;
      setChatError(null);
      if (activeChatId !== null) {
        setInternalChatId(activeChatId);
      } else {
        // "New chat" clicked — generate fresh id
        setInternalChatId(generateClientId());
      }
    }
  }, [activeChatId]);

  useEffect(() => {
    const focusIfRequested = () => {
      if (typeof window === "undefined") return;
      if (window.sessionStorage.getItem("eggent-focus-chat-input") !== "1") return;
      window.sessionStorage.removeItem("eggent-focus-chat-input");
      setInputFocusSignal((value) => value + 1);
    };

    focusIfRequested();
    const listener = () => setInputFocusSignal((value) => value + 1);
    window.addEventListener("eggent:focus-chat-input", listener);
    return () => window.removeEventListener("eggent:focus-chat-input", listener);
  }, []);

  // Stable transport — body is a function so it always reads current refs.
  // /api/chat uses the pi SDK backend by default; override only for experiments.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: process.env.NEXT_PUBLIC_EGGENT_CHAT_API || "/api/chat",
        body: () => ({
          chatId: internalChatIdRef.current,
          projectId: activeProjectIdRef.current,
          currentPath: currentPathRef.current,
        }),
      }),
    []
  );

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    id: internalChatId,
    transport,
    onError: (error) => {
      console.error("Chat error:", error);
      setChatError(formatChatErrorMessage(error));
    },
  });

  const runtimeStats = useMemo(() => getLatestPiRuntimeStats(messages), [messages]);
  const displayRuntimeStats = useMemo(() => {
    if (!runtimeStats) return configuredRuntimeStats;
    if (runtimeStats.model || !configuredRuntimeStats?.model) return runtimeStats;
    return {
      ...runtimeStats,
      model: configuredRuntimeStats.model,
      context: runtimeStats.context ?? configuredRuntimeStats.context,
    };
  }, [configuredRuntimeStats, runtimeStats]);

  useEffect(() => {
    let cancelled = false;
    const params = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : "";
    fetch(`/api/pi-chat/model${params}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to load pi model");
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!cancelled && isPiRuntimeStats(data)) {
          setConfiguredRuntimeStats(data);
        }
      })
      .catch(() => {
        if (!cancelled) setConfiguredRuntimeStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, syncTick]);

  // Don't overwrite messages while a request is in flight (avoids "blink" on new chat)
  const statusRef = useRef(status);
  statusRef.current = status;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const pendingProjectSwitchRef = useRef(false);
  const submissionStartCountRef = useRef<number | null>(null);
  const handledSwitchToolCallsRef = useRef<Set<string>>(new Set());
  const queuedSwitchResultRef = useRef<SwitchProjectResult | null>(null);
  const shouldRefreshProjectsRef = useRef(false);
  const switchInFlightRef = useRef(false);

  // Reset local messages when switching to "new chat" mode.
  useEffect(() => {
    if (activeChatId === null) {
      setMessages([]);
    }
  }, [activeChatId, setMessages]);

  // Keep active chat history synced with background updates.
  useEffect(() => {
    if (activeChatId === null) return;
    if (status === "submitted" || status === "streaming") return;

    let cancelled = false;
    fetch(`/api/chat/history?id=${encodeURIComponent(activeChatId)}`)
      .then((r) => {
        if (r.status === 404) {
          return null;
        }
        if (!r.ok) throw new Error("Failed to load chat");
        return r.json() as Promise<{ messages?: ChatMessage[] }>;
      })
      .then((chat) => {
        if (cancelled) return;
        // Don't overwrite while user is sending or stream is in progress
        if (statusRef.current === "submitted" || statusRef.current === "streaming") {
          return;
        }

        if (!chat?.messages) {
          setMessages([]);
          return;
        }

        const nextMessages = chatMessagesToUIMessages(chat.messages);
        if (areUIMessagesEquivalentById(messagesRef.current, nextMessages)) {
          return;
        }
        setMessages(nextMessages);
      })
      .catch(() => {
        // Keep last known messages on transient polling/network errors.
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMessages, status, syncTick]);

  const refreshProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      const data = await response.json();
      if (Array.isArray(data)) {
        setProjects(data);
      }
    } catch {
      // ignore project list refresh failures
    }
  }, [setProjects]);

  const applySwitchResult = useCallback(
    (result: SwitchProjectResult) => {
      if (switchInFlightRef.current) return;
      const nextProjectId = typeof result.projectId === "string" ? result.projectId.trim() : null;

      switchInFlightRef.current = true;
      try {
        if (activeProjectIdRef.current === nextProjectId) {
          setCurrentPath(result.currentPath ?? "");
          return;
        }
        setActiveProjectId(nextProjectId);
        setCurrentPath(result.currentPath ?? "");
      } finally {
        switchInFlightRef.current = false;
      }
    },
    [setActiveProjectId, setCurrentPath]
  );

  useEffect(() => {
    if (!pendingProjectSwitchRef.current) return;

    if (status === "submitted") return;

    const startIndex = submissionStartCountRef.current ?? messages.length;
    const recentMessages = messages.slice(startIndex);
    const latestAssistant = [...recentMessages]
      .reverse()
      .find((m) => m.role === "assistant");
    const assistantMessages = recentMessages.filter(
      (m): m is UIMessage => m.role === "assistant"
    );
    const hasToolOutput = assistantMessages.some((m) =>
      assistantMessageHasToolOutput(m)
    );
    const hasVisibleAssistantAnswer = assistantMessages.some((m) =>
      Boolean(extractVisibleAssistantText(m))
    );

    if (latestAssistant) {
      for (let idx = 0; idx < latestAssistant.parts.length; idx++) {
        const part = latestAssistant.parts[idx];
        const switchInfo = extractToolPartInfo(part, "switch_project");
        if (switchInfo) {
          const key = switchInfo.key || `${latestAssistant.id}-${idx}-switch`;
          if (!handledSwitchToolCallsRef.current.has(key)) {
            handledSwitchToolCallsRef.current.add(key);
            const parsedSwitch = tryParseSwitchProjectResult(switchInfo.output);
            if (parsedSwitch) {
              queuedSwitchResultRef.current = parsedSwitch;
              shouldRefreshProjectsRef.current = true;
            }
          }
        }

        const createInfo = extractToolPartInfo(part, "create_project");
        if (createInfo) {
          const key = createInfo.key || `${latestAssistant.id}-${idx}-create`;
          if (!handledSwitchToolCallsRef.current.has(key)) {
            handledSwitchToolCallsRef.current.add(key);
            const parsedCreate = tryParseCreateProjectResult(createInfo.output);
            if (parsedCreate) {
              shouldRefreshProjectsRef.current = true;
            }
          }
        }
      }
    }

    if (status === "ready" || status === "error") {
      if (hasToolOutput && !hasVisibleAssistantAnswer) {
        const alreadyPresent = assistantMessages.some(
          (m) => extractVisibleAssistantText(m) === NO_FINAL_RESPONSE_FALLBACK
        );
        setChatError(NO_FINAL_RESPONSE_FALLBACK);
        if (!alreadyPresent) {
          setMessages((prev) => [
            ...prev,
            {
              id: generateClientId(),
              role: "assistant",
              parts: [{ type: "text", text: NO_FINAL_RESPONSE_FALLBACK }],
            },
          ]);
        }
      }

      const queued = queuedSwitchResultRef.current;
      const shouldRefresh = shouldRefreshProjectsRef.current || Boolean(queued);
      pendingProjectSwitchRef.current = false;
      submissionStartCountRef.current = null;
      handledSwitchToolCallsRef.current.clear();
      queuedSwitchResultRef.current = null;
      shouldRefreshProjectsRef.current = false;

      void (async () => {
        if (shouldRefresh) {
          await refreshProjects();
        }
        if (queued) {
          applySwitchResult(queued);
        }
      })();
    }
  }, [messages, status, applySwitchResult, refreshProjects, setMessages]);

  const isLoading = status === "submitted" || status === "streaming";

  const onSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return;
    setChatError(null);

    pendingProjectSwitchRef.current = true;
    submissionStartCountRef.current = messagesRef.current.length;
    handledSwitchToolCallsRef.current.clear();
    queuedSwitchResultRef.current = null;
    shouldRefreshProjectsRef.current = false;

    // If no active chat, register in the store.
    // Update prevActiveChatId ref BEFORE setActiveChatId so the
    // useEffect above won't treat this as external navigation.
    if (!activeChatId) {
      prevActiveChatId.current = internalChatId;
      setActiveChatId(internalChatId);
      addChat({
        id: internalChatId,
        title: input.slice(0, 60) + (input.length > 60 ? "..." : ""),
        projectId: activeProjectId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
      });
    }

    sendMessage({ text: input });
    setInput("");
  }, [
    input,
    isLoading,
    activeChatId,
    internalChatId,
    setActiveChatId,
    addChat,
    activeProjectId,
    sendMessage,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ChatMessages messages={messages} isLoading={isLoading} errorMessage={chatError} />
      <ChatInput
        input={input}
        setInput={setInput}
        onSubmit={onSubmit}
        onStop={stop}
        isLoading={isLoading}
        chatId={activeChatId || internalChatId}
        focusSignal={inputFocusSignal}
        runtimeStats={displayRuntimeStats}
      />
    </div>
  );
}
