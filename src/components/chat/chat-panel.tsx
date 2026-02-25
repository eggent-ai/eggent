"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ChatMessages } from "./chat-messages";
import { ChatInput } from "./chat-input";
import { useAppStore } from "@/store/app-store";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { ChatMessage } from "@/lib/types";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { generateClientId } from "@/lib/utils";

/** Convert stored ChatMessage to UIMessage (parts format for useChat) */
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
  projectId?: string;
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

  const projectId = typeof record.projectId === "string" ? record.projectId : undefined;
  if (!projectId?.trim()) {
    return null;
  }

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

  // Internal chatId that stays stable during a message send.
  // Pre-generate a UUID so useChat always has a consistent id.
  const [internalChatId, setInternalChatId] = useState(
    () => activeChatId || generateClientId()
  );
  const syncTick = useBackgroundSync({
    topics: ["chat", "global"],
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
      if (activeChatId !== null) {
        setInternalChatId(activeChatId);
      } else {
        // "New chat" clicked — generate fresh id
        setInternalChatId(generateClientId());
      }
    }
  }, [activeChatId]);

  // Stable transport — body is a function so it always reads current refs
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
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
    },
  });

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
      const nextProjectId = result.projectId?.trim();
      if (!nextProjectId) return;

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
  }, [messages, status, applySwitchResult, refreshProjects]);

  const isLoading = status === "submitted" || status === "streaming";

  const onSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return;

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
    <div className="flex flex-col h-full">
      <ChatMessages messages={messages} isLoading={isLoading} />
      <ChatInput
        input={input}
        setInput={setInput}
        onSubmit={onSubmit}
        onStop={stop}
        isLoading={isLoading}
        chatId={activeChatId || internalChatId}
      />
    </div>
  );
}
