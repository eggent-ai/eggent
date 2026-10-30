"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useI18n } from "@/i18n/provider";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatSurfaceProvider } from "@/components/chat/chat-surface";
import { chatMessagesToUIMessages, getLatestPendingInteraction } from "@/lib/chat/ui-messages";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import type { ChatMessage } from "@/lib/types";

/**
 * The workspace's chat, for a guest: somebody asking a project that was shared
 * with them - a visitor of a public link, or a person of the company asking the
 * administrator's project from their own workspace.
 *
 * The same messages, tool rows, question cards and composer as the workspace's
 * own chat (ChatMessages, ChatInput), fed by whichever host lets the guest in.
 * What a guest has no use for is not there: models, modes, commands, the shell,
 * other projects, files, and saying something to a turn at work.
 */

/** Where this guest's host answers. Every call names the conversation; the host decides whose it is. */
export interface GuestChatEndpoints {
  /** POST {message, conversation?} -> the answer as a UI message stream; `X-Eggent-Conversation` names a new one. */
  send: string;
  /** GET -> {chat: {title, messages, running} | null} */
  history: (conversation: string) => string;
  /** GET -> the turn working now, from its start, or 204. */
  resume: (conversation: string) => string;
  /** POST {conversation} */
  stop: string;
  /** POST {conversation, interactionId, value, cancel} */
  answer: string;
  /** Where a recording is turned into words; the workspace's own route when absent. */
  transcribe?: string;
}

interface GuestChatProps {
  endpoints: GuestChatEndpoints;
  /** The conversation to open; null starts a new one with the first message. */
  conversation: string | null;
  /** The first answer named the conversation it went into. */
  onConversation?: (conversation: string) => void;
  /** A turn finished: the list of conversations may have changed. */
  onSettled?: () => void;
  /** An answer started or ended being written: switching conversations waits for it. */
  onBusyChange?: (busy: boolean) => void;
  /** What an empty conversation says. */
  empty: { title: string; description?: string };
  /** The line under the composer. */
  note?: string;
  /** Above the conversation: a title, a conversation switcher. */
  header?: ReactNode;
}

async function errorText(response: Response, fallback: string): Promise<string> {
  const data = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" && data.error ? data.error : fallback;
}

export function GuestChat({ endpoints, conversation, onConversation, onSettled, onBusyChange, empty, note, header }: GuestChatProps) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(Boolean(conversation));
  // The conversation the next message goes into: the one opened, or the one the
  // first answer named. A ref, because the transport reads it when it sends.
  const conversationRef = useRef<string | null>(conversation);
  const onConversationRef = useRef(onConversation);
  onConversationRef.current = onConversation;
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  // One useChat per conversation opened here; a conversation named mid-answer keeps it.
  const [chatKey] = useState(() => conversation ?? `new-${Math.random().toString(36).slice(2)}`);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: endpoints.send,
        prepareSendMessagesRequest: ({ messages }) => {
          const last = [...messages].reverse().find((message) => message.role === "user");
          const text = last?.parts.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
          return { body: { message: text, ...(conversationRef.current ? { conversation: conversationRef.current } : {}) } };
        },
        prepareReconnectToStreamRequest: () => ({ api: endpointsRef.current.resume(conversationRef.current ?? "") }),
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok && response.status !== 204) throw new Error(await errorText(response, t("guestChat.failed")));
          const named = response.headers.get("x-eggent-conversation");
          if (named && named !== conversationRef.current) {
            conversationRef.current = named;
            onConversationRef.current?.(named);
          }
          return response;
        },
      }),
    // The transport is made once per screen; what it reads changes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const { messages, sendMessage, status, setMessages, resumeStream } = useChat({
    id: chatKey,
    transport,
    onError: (failure) => setError(failure.message || t("guestChat.failed")),
    onFinish: () => onSettled?.(),
  });
  const isLoading = status === "submitted" || status === "streaming";
  const surface = useMemo(() => ({ guest: true, transcribeUrl: endpoints.transcribe }), [endpoints.transcribe]);
  const pendingInteraction = useMemo(() => getLatestPendingInteraction(messages), [messages]);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  useEffect(() => {
    onBusyChangeRef.current?.(isLoading);
  }, [isLoading]);

  // The stored conversation, and the turn still working in it if there is one.
  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(endpointsRef.current.history(conversation), { cache: "no-store" });
        if (!response.ok) throw new Error(await errorText(response, t("guestChat.historyFailed")));
        const data = (await response.json()) as { chat: { messages: ChatMessage[]; running: boolean } | null };
        if (cancelled) return;
        const stored = data.chat ? chatMessagesToUIMessages(data.chat.messages) : [];
        // A turn waiting on a question is stored half-written; attaching replays it whole.
        const running = data.chat?.running === true;
        const last = stored[stored.length - 1];
        setMessages(running && last?.role === "assistant" ? stored.slice(0, -1) : stored);
        if (running) void resumeStream();
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("guestChat.historyFailed"));
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Loaded once, for the conversation this screen was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = useCallback(async (url: string, body: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, conversation: conversationRef.current }),
    });
    if (!response.ok) throw new Error(await errorText(response, t("guestChat.failed")));
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }, [t]);

  const respond = useCallback(async (interaction: PiPendingInteraction, value: string | boolean | null, cancel = false) => {
    setError(null);
    try {
      const result = await post(endpointsRef.current.answer, { interactionId: interaction.id, value, cancel });
      if (result.answered === false) throw new Error(t("guestChat.answerFailed"));
      setInput("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("guestChat.answerFailed"));
    }
  }, [post, t]);

  const onSubmit = useCallback((messageOverride?: string) => {
    const typed = (messageOverride ?? input).trim();
    if (pendingInteraction) {
      if (!typed && pendingInteraction.kind !== "confirm") return;
      void respond(pendingInteraction, typed);
      return;
    }
    if (!typed || isLoading) return;
    setError(null);
    setInput("");
    void sendMessage({ text: typed, metadata: { createdAt: new Date().toISOString() } });
  }, [input, isLoading, pendingInteraction, respond, sendMessage]);

  const onStop = useCallback(() => {
    void post(endpointsRef.current.stop, {}).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : t("guestChat.failed"));
    });
  }, [post, t]);

  return (
    <ChatSurfaceProvider value={surface}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {header}
        <ChatMessages
          messages={messages}
          isLoading={isLoading}
          errorMessage={error}
          pendingInteraction={pendingInteraction}
          onRespondToInteraction={(value, cancel) => (pendingInteraction ? void respond(pendingInteraction, value, cancel) : undefined)}
          awaitingHistory={loadingHistory}
          empty={empty}
        />
        <ChatInput
          input={input}
          setInput={setInput}
          onSubmit={onSubmit}
          onStop={onStop}
          isLoading={isLoading}
          pendingInteraction={pendingInteraction}
          disabled={loadingHistory}
          guest={{ note }}
        />
      </div>
    </ChatSurfaceProvider>
  );
}
