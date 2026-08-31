"use client";

import { useChat } from "@ai-sdk/react";
import { usePathname, useRouter } from "next/navigation";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ChatMessages, type QuickSkillAction } from "./chat-messages";
import { ChatInput } from "./chat-input";
import { useAppStore } from "@/store/app-store";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";
import type { PiRuntimeStats } from "@/lib/pi/types";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useActiveRuns } from "@/hooks/use-active-runs";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { DASHBOARD_CHAT_ROOT, chatPath } from "@/lib/dashboard-routes";
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

export interface PiCompactionStatus {
  state: "running" | "completed" | "failed";
  reason?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  message: string;
  timestamp?: string;
}

function isPiCompactionStatus(value: unknown): value is PiCompactionStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.state === "running" || record.state === "completed" || record.state === "failed") &&
    typeof record.message === "string"
  );
}

function getLatestPiCompactionStatus(messages: UIMessage[]): PiCompactionStatus | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j] as { type?: string; data?: unknown };
      if (part.type === "data-piCompaction" && isPiCompactionStatus(part.data)) {
        return part.data;
      }
    }
  }
  return null;
}

export interface EggentActionNotice {
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
  timestamp?: string;
}

function isEggentActionNotice(value: unknown): value is EggentActionNotice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.title === "string" || typeof record.body === "string";
}

/** Only surface a notice raised during the current turn, not stale ones from history. */
function getLatestEggentNotice(messages: UIMessage[]): EggentActionNotice | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return null;
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j] as { type?: string; data?: unknown };
      if (part.type === "data-eggentNotice" && isEggentActionNotice(part.data)) {
        return part.data;
      }
    }
  }
  return null;
}

function isPiInteraction(value: unknown): value is PiPendingInteraction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.runId === "string" &&
    typeof record.kind === "string" &&
    typeof record.title === "string" &&
    typeof record.status === "string"
  );
}

function getLatestPendingInteraction(messages: UIMessage[]): PiPendingInteraction | null {
  const closedInteractionIds = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j] as { type?: string; data?: unknown };
      if (part.type !== "data-piInteraction" || !isPiInteraction(part.data)) continue;
      if (part.data.status === "pending" && !closedInteractionIds.has(part.data.id)) {
        return part.data;
      }
      if (part.data.status !== "pending") {
        closedInteractionIds.add(part.data.id);
      }
    }
  }
  return null;
}

function storedPartToUIPart(part: ChatMessagePart): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text };
  }

  return {
    type: `tool-${part.toolName}` as `tool-${string}`,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    state: part.status === "error" ? "output-error" as const : "output-available" as const,
    input: part.args,
    output: part.output ?? "",
  } as unknown as UIMessage["parts"][number];
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

      if (m.parts?.length) {
        for (const storedPart of m.parts) {
          const uiPart = storedPartToUIPart(storedPart);
          if (uiPart) parts.push(uiPart);
        }
      } else {
        // Legacy chats did not persist ordered parts. Keep the old fallback shape.
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

        if (m.content) {
          parts.push({ type: "text" as const, text: m.content });
        }
      }

      // Keep runtime stats in the message stream so the footer remains
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

function formatChatErrorMessage(error: unknown, t: (key: MessageKey) => string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return t("chat.errors.emptyFinal");
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

interface ChatPanelProps {
  initialQuickSkills?: QuickSkillAction[];
}

export function ChatPanel({ initialQuickSkills = [] }: ChatPanelProps) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const noFinalResponseFallback = t("chat.errors.noFinalAfterTools");
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
  const [quickSkills, setQuickSkills] = useState<QuickSkillAction[]>(initialQuickSkills);
  const [launchingSkill, setLaunchingSkill] = useState<string | null>(null);
  // Which chat's stored messages are on screen. Attaching to a running turn has
  // to wait for this, or the answer arrives over an empty transcript. Cleared
  // whenever the open chat changes, so it always means "this visit", never "the
  // last time this chat happened to be open".
  const [loadedHistoryChatId, setLoadedHistoryChatId] = useState<string | null>(null);
  // The chat whose history could not be fetched. Kept apart from the marker
  // above on purpose: for the screen this settles the question - stop waiting
  // and show what we have - but for attaching to a running turn it settles
  // nothing, and attaching over a transcript we failed to load is the thing
  // that marker exists to prevent.
  const [historyFailedChatId, setHistoryFailedChatId] = useState<string | null>(null);
  // Set beside it: a conversation whose stored messages end on the person's own
  // message had something answering it. That is worth trying to attach to
  // without waiting to be told, because it is exactly the state a chat is in
  // while a turn is running - the question is stored when the turn starts, the
  // answer only when it ends.
  const historyEndsOnUserRef = useRef(false);
  // Set from the moment stop is pressed until the server says the turn is over
  // and written down. Reloading the conversation inside that window reads the
  // chat before the half-written answer has landed in it, and the person who
  // just chose to keep that answer watches it disappear instead. State rather
  // than a ref, so clearing it is what asks for the reload.
  const [stopSettling, setStopSettling] = useState(false);
  const stopSettlingRef = useRef(false);
  stopSettlingRef.current = stopSettling;

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

  // Assigned during render, so it always closes over the chat being left rather
  // than the one being opened.
  const stopStreamRef = useRef<() => void>(() => {});

  // Sync internalChatId when user navigates to a different chat via sidebar
  useEffect(() => {
    if (activeChatId !== prevActiveChatId.current) {
      prevActiveChatId.current = activeChatId;
      setChatError(null);
      // Leaving a conversation ends this view of it and not the turn: the run
      // carries on server-side and we attach to it again on the way back. What
      // this panel was tracking belongs to the chat being left, so it stops
      // being tracked here - otherwise a turn interrupted by navigation reads
      // as one that failed to answer.
      pendingProjectSwitchRef.current = false;
      submissionStartCountRef.current = null;
      stopStreamRef.current();
      // Both belong to the conversation being left. Keeping the attach attempt
      // was the bug this comment exists for: coming back to a chat that was
      // still working showed the opening message and nothing else, because the
      // attempt had already been spent on the previous visit and only a refresh
      // of the run list - a window focus, or the 30s poll - would mint a new
      // one. Keeping the loaded-history marker is the other half: it would let
      // the next attach run against the previous visit's transcript.
      resumeAttemptRef.current = null;
      setLoadedHistoryChatId(null);
      setHistoryFailedChatId(null);
      if (activeChatId !== null) {
        setInternalChatId(activeChatId);
      } else {
        // "New chat" clicked — generate fresh id
        setInternalChatId(generateClientId());
      }
    }
  }, [activeChatId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(t("chat.errors.loadBundledSkills"));
        return response.json() as Promise<QuickSkillAction[]>;
      })
      .then((skills) => {
        if (!cancelled) setQuickSkills(Array.isArray(skills) ? skills : []);
      })
      .catch(() => {
        if (!cancelled) setQuickSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);


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
  // /api/chat uses the Eggent agent backend by default; override only for experiments.
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

  const { messages, sendMessage, status, stop, setMessages, resumeStream } = useChat({
    id: internalChatId,
    transport,
    onError: (error) => {
      console.error("Chat error:", error);
      setChatError(formatChatErrorMessage(error, t));
    },
  });
  stopStreamRef.current = stop;

  const activeRuns = useActiveRuns();
  const activeRunForChat = activeRuns.byChat.get(internalChatId);
  const refreshActiveRuns = activeRuns.refresh;

  const runtimeStats = useMemo(() => getLatestPiRuntimeStats(messages), [messages]);
  const compactionStatus = useMemo(() => getLatestPiCompactionStatus(messages), [messages]);
  const actionNotice = useMemo(() => getLatestEggentNotice(messages), [messages]);
  const pendingInteraction = useMemo(() => getLatestPendingInteraction(messages), [messages]);
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
        if (!response.ok) throw new Error("Failed to load configured model");
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
  const stopRequestedRef = useRef(false);
  /** The last attach this panel asked for; cleared when the open chat changes. */
  const resumeAttemptRef = useRef<string | null>(null);

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
    if (stopSettling) return;

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
        if (stopSettlingRef.current) return;

        if (!chat?.messages) {
          setMessages([]);
          historyEndsOnUserRef.current = false;
          setLoadedHistoryChatId(activeChatId);
          return;
        }

        const nextMessages = chatMessagesToUIMessages(chat.messages);
        if (!areUIMessagesEquivalentById(messagesRef.current, nextMessages)) {
          setMessages(nextMessages);
        }
        historyEndsOnUserRef.current =
          nextMessages[nextMessages.length - 1]?.role === "user";
        setLoadedHistoryChatId(activeChatId);
      })
      .catch(() => {
        // Keep last known messages on transient polling/network errors, but
        // stop waiting: a loading shape that never resolves is worse than the
        // empty screen it replaced. The next sync tick tries again.
        if (!cancelled) setHistoryFailedChatId(activeChatId);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMessages, status, stopSettling, syncTick]);

  // Nothing about clicking a chat produces an event, so the run list can be
  // seconds stale exactly when it is being read. Ask on arrival: it decides
  // whether to attach, and it puts the mark on the row. Unconditional on
  // purpose - the answer is a few bytes, and gating it on the status would skip
  // the arrival that matters, the one that interrupted a stream.
  useEffect(() => {
    refreshActiveRuns();
  }, [internalChatId, refreshActiveRuns]);

  // Coming back to a chat that is still working.
  //
  // The stored chat holds the opening message and nothing else until the turn
  // ends, so without this the screen is a question with no answer under it -
  // for as long as the work takes. Attaching to the run replays everything the
  // agent has produced since and then follows it live, which is what the tab
  // that started it has been seeing all along.
  //
  // One attempt per reason to attach, and leaving the chat forgets them all, so
  // arriving is always a fresh reason. It used to be one attempt per run per
  // refresh of the list and nothing else, which meant the second visit to a
  // working chat was silently skipped - the attempt had been spent on the first
  // - until something happened to bump the list. Focusing the window did it,
  // which is why the screen came back to life when the person clicked away and
  // back rather than when they opened the chat.
  useEffect(() => {
    if (status === "submitted" || status === "streaming") return;
    // Only for the conversation the panel has settled on. Mid-switch these two
    // disagree for one render, and attaching then would open a stream for the
    // chat being left.
    if (!internalChatId || activeChatId !== internalChatId) return;
    // Stored messages first, always. The turn in flight is only the tail of the
    // conversation, and attaching before the rest of it has loaded put the
    // answer on screen without the question that asked for it - and then the
    // history load, which refuses to write over a running stream, never got
    // another chance until the turn ended.
    if (loadedHistoryChatId !== internalChatId) return;

    // Two reasons to attach, and the run list is only one of them. A
    // conversation that ends on the person's own message is one somebody was
    // answering, and that is worth acting on without waiting to be told -
    // otherwise a stale list means the turn stays invisible, and a turn that is
    // waiting on a question stays invisible for as long as it waits, because
    // the question lives only in the stream and never in the stored chat.
    const attempt = activeRunForChat
      ? `${internalChatId}:${activeRunForChat.runId}:${activeRuns.version}`
      : historyEndsOnUserRef.current
        ? `${internalChatId}:unanswered`
        : null;
    if (!attempt || resumeAttemptRef.current === attempt) return;
    resumeAttemptRef.current = attempt;
    void resumeStream();
  }, [
    activeChatId,
    activeRunForChat,
    activeRuns.version,
    internalChatId,
    loadedHistoryChatId,
    resumeStream,
    status,
  ]);

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
        // The agent moved to get the work done; the person did not ask to go
        // anywhere. Keep them in the conversation they are having - the runtime
        // resumes the session by chat id, so it carries into the new project
        // intact, and only the project indicator follows the agent.
        setActiveProjectId(nextProjectId, { keepActiveChat: true });
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
      const wasStoppedByUser = stopRequestedRef.current;
      if (!wasStoppedByUser && hasToolOutput && !hasVisibleAssistantAnswer) {
        const alreadyPresent = assistantMessages.some(
          (m) => extractVisibleAssistantText(m) === noFinalResponseFallback
        );
        setChatError(noFinalResponseFallback);
        if (!alreadyPresent) {
          setMessages((prev) => [
            ...prev,
            {
              id: generateClientId(),
              role: "assistant",
              parts: [{ type: "text", text: noFinalResponseFallback }],
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
      stopRequestedRef.current = false;

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

  // Between opening a conversation and its messages arriving there is nothing
  // to show, and what used to fill it was the new-chat screen - asking what to
  // start, on top of something already started. It is only a question for a
  // chat that does not exist yet.
  //
  // The address decides, not the store. The store learns which conversation is
  // open one tick after the page does, and on a first load it starts out empty:
  // that put the new-chat screen into the server-rendered html of every
  // conversation opened from a link, before the client had even asked for the
  // messages.
  const addressNamesAChat = pathname !== DASHBOARD_CHAT_ROOT;
  const historySettled =
    activeChatId !== null &&
    (loadedHistoryChatId === activeChatId || historyFailedChatId === activeChatId);
  const awaitingHistory = addressNamesAChat && !historySettled;

  const registerOutgoingChat = useCallback((messageText: string, projectId: string | null | undefined) => {
    if (!activeChatId) {
      prevActiveChatId.current = internalChatId;
      setActiveChatId(internalChatId);
      addChat({
        id: internalChatId,
        title: messageText.slice(0, 60) + (messageText.length > 60 ? "..." : ""),
        projectId: projectId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
      });
      // The conversation exists from this message on, so give it its address.
      // Replace rather than push: the empty composer it is replacing is not
      // somewhere to go back to, and Back should reach whatever was open
      // before. Both addresses share one layout, so the turn that is already
      // being sent is not interrupted by the change.
      router.replace(chatPath(internalChatId));
    }
  }, [activeChatId, internalChatId, setActiveChatId, addChat, router]);

  const respondToInteraction = useCallback(async (interaction: PiPendingInteraction, value: string | boolean | null, cancel = false) => {
    try {
      setChatError(null);
      const response = await fetch(
        `/api/pi-runs/${encodeURIComponent(interaction.runId)}/interactions/${encodeURIComponent(interaction.id)}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value, cancel }),
        }
      );
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || t("chat.errors.sendResponse"));
      }
      setInput("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : t("chat.errors.sendResponse"));
    }
  }, []);

  const onSubmit = useCallback((messageOverride?: string) => {
    const messageText = messageOverride ?? input;
    if (pendingInteraction) {
      const trimmed = messageText.trim();
      if (!trimmed && pendingInteraction.kind !== "confirm") return;
      void respondToInteraction(pendingInteraction, trimmed);
      return;
    }
    if (!messageText.trim() || isLoading) return;
    setChatError(null);
    stopRequestedRef.current = false;

    pendingProjectSwitchRef.current = true;
    submissionStartCountRef.current = messagesRef.current.length;
    handledSwitchToolCallsRef.current.clear();
    queuedSwitchResultRef.current = null;
    shouldRefreshProjectsRef.current = false;

    registerOutgoingChat(messageText, activeProjectId);

    sendMessage({ text: messageText });
    setInput("");
  }, [
    input,
    pendingInteraction,
    respondToInteraction,
    isLoading,
    activeProjectId,
    sendMessage,
    registerOutgoingChat,
  ]);

  // No target is sent on purpose: the server gives the skill its home, and the
  // response says which one so the chat can follow it there.
  const launchBundledSkill = useCallback(async (skillName: string) => {
    if (isLoading || launchingSkill) return;
    try {
      setLaunchingSkill(skillName);
      setChatError(null);
      const response = await fetch("/api/skills/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillName }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        projectId?: string | null;
        initialMessage?: string;
      } | null;
      if (!response.ok || !payload?.initialMessage) {
        throw new Error(payload?.error || t("chat.errors.launchSkill"));
      }

      const projectId = payload.projectId ?? null;
      const messageText = payload.initialMessage;
      stopRequestedRef.current = false;
      submissionStartCountRef.current = messagesRef.current.length;
      handledSwitchToolCallsRef.current.clear();
      queuedSwitchResultRef.current = null;

      // Installing into a project means running there; the orchestrator scope
      // is where the chat already is, so nothing needs to switch.
      if (projectId) {
        await refreshProjects();
        activeProjectIdRef.current = projectId;
        currentPathRef.current = "";
        setActiveProjectId(projectId);
        setCurrentPath("");
        pendingProjectSwitchRef.current = true;
        shouldRefreshProjectsRef.current = true;
      }

      registerOutgoingChat(messageText, projectId);
      sendMessage({ text: messageText });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : t("chat.errors.launchSkill"));
    } finally {
      setLaunchingSkill(null);
    }
  }, [isLoading, launchingSkill, refreshProjects, registerOutgoingChat, sendMessage, setActiveProjectId, setCurrentPath]);

  // A card is an offer to start something, so it starts it. Asking which
  // project to install into put a decision in front of people who had nothing
  // to base it on yet, one screen before they had seen the skill work at all;
  // the server now picks the home - a new project for a piece of work, the
  // orchestrator for the skills that describe the workspace itself.
  const requestSkillLaunch = useCallback((skillName: string) => {
    if (isLoading || launchingSkill) return;
    setChatError(null);
    void launchBundledSkill(skillName);
  }, [isLoading, launchingSkill, launchBundledSkill]);

  const handleStop = useCallback(() => {
    const snapshot = messagesRef.current;
    stopRequestedRef.current = true;
    setStopSettling(true);
    stopSettlingRef.current = true;
    stop();
    // Dropping the connection is no longer what stops a turn - that is the whole
    // point of the run outliving the tab - so the intent has to be sent. It
    // reaches the run wherever it was started from, including Telegram, and it
    // answers once the half-written turn has been stored.
    void fetch(`/api/chat/${encodeURIComponent(internalChatIdRef.current)}/stop`, {
      method: "POST",
    })
      .catch(() => {
        // Nothing useful to say here: the turn either stopped or is about to
        // finish on its own, and the history sync shows whichever happened.
      })
      .finally(() => {
        // Clearing this is what asks for the reload, and by now the stored copy
        // is the one that answers it.
        stopSettlingRef.current = false;
        setStopSettling(false);
      });
    // The AI SDK clears the in-flight assistant message on client abort. Put the
    // last streamed snapshot back immediately; the server persists the same
    // partial turn and the normal history sync will reconcile it afterwards.
    queueMicrotask(() => setMessages(snapshot));
    setTimeout(() => setMessages(snapshot), 0);
  }, [setMessages, stop]);

  const showQuickSkills = !activeProjectId && activeChatId === null && messages.length === 0 ? quickSkills : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ChatMessages
        messages={messages}
        isLoading={isLoading}
        errorMessage={chatError}
        compactionStatus={compactionStatus}
        actionNotice={actionNotice}
        pendingInteraction={pendingInteraction}
        onRespondToInteraction={(value, cancel) => pendingInteraction ? respondToInteraction(pendingInteraction, value, cancel) : undefined}
        quickSkills={showQuickSkills}
        onLaunchSkill={requestSkillLaunch}
        launchingSkill={launchingSkill}
        awaitingHistory={awaitingHistory}
      />
      <ChatInput
        input={input}
        setInput={setInput}
        onSubmit={onSubmit}
        onStop={handleStop}
        isLoading={isLoading}
        pendingInteraction={pendingInteraction}
        chatId={activeChatId || internalChatId}
        projectId={activeProjectId}
        currentPath={currentPath}
        focusSignal={inputFocusSignal}
        runtimeStats={displayRuntimeStats}
      />
    </div>
  );
}
