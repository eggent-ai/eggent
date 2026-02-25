"use client";

import { useEffect, useRef } from "react";
import { MessageBubble } from "./message-bubble";
import { Loader2 } from "lucide-react";
import type { UIMessage } from "ai";

interface ChatMessagesProps {
  messages: UIMessage[];
  isLoading: boolean;
}

export function ChatMessages({ messages, isLoading }: ChatMessagesProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-md">
          <div className="flex justify-center">
            <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <svg
                className="size-8 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
                />
              </svg>
            </div>
          </div>
          <h3 className="text-lg font-semibold">Start a conversation</h3>
          <p className="text-sm text-muted-foreground">
            Send a message to begin chatting with the AI agent. It can execute
            code, search the web, manage memory, and more.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-6">
      <div className="max-w-3xl mx-auto py-4 space-y-1">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {isLoading && messages.length > 0 && (
          <div className="flex gap-3 py-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Loader2 className="size-4 animate-spin" />
            </div>
            <div className="flex items-center">
              <span className="text-sm text-muted-foreground">
                Thinking...
              </span>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}
