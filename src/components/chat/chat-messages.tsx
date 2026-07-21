"use client";

import { useCallback, useEffect, useRef } from "react";
import { MessageBubble } from "./message-bubble";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Loader2, MessageCircle, Sparkles } from "lucide-react";
import type { UIMessage } from "ai";

export interface QuickSkillAction {
  name: string;
  description: string;
}

interface ChatMessagesProps {
  messages: UIMessage[];
  isLoading: boolean;
  errorMessage?: string | null;
  quickSkills?: QuickSkillAction[];
  onLaunchSkill?: (skillName: string) => void;
  launchingSkill?: string | null;
}

export function ChatMessages({ messages, isLoading, errorMessage, quickSkills = [], onLaunchSkill, launchingSkill }: ChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const AUTO_SCROLL_THRESHOLD_PX = 96;

  const updateShouldAutoScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    endRef.current?.scrollIntoView({
      behavior: isLoading ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, isLoading]);

  useEffect(() => {
    updateShouldAutoScroll();
  }, [updateShouldAutoScroll]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Empty className="border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
              <MessageCircle />
            </EmptyMedia>
            <EmptyTitle>Start a conversation</EmptyTitle>
            <EmptyDescription>
              Ask anything, paste an image, or attach files. Eggent will use the current project context when needed.
            </EmptyDescription>
          </EmptyHeader>
          {quickSkills.length > 0 ? (
            <div className="mt-6 grid w-full max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {quickSkills.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  onClick={() => onLaunchSkill?.(skill.name)}
                  disabled={!onLaunchSkill || Boolean(launchingSkill)}
                  className="group flex min-h-44 flex-col justify-between rounded-2xl border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="space-y-3">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
                      {launchingSkill === skill.name ? <Loader2 className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
                    </div>
                    <div>
                      <div className="font-semibold leading-tight">{skill.name}</div>
                      <p className="mt-2 line-clamp-4 text-sm leading-5 text-muted-foreground">{skill.description}</p>
                    </div>
                  </div>
                  <div className="mt-4 text-xs font-medium text-primary">
                    {launchingSkill === skill.name ? "Creating project…" : "Set up"}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </Empty>
      </div>
    );
  }

  const latestMessage = messages[messages.length - 1];
  const hasLiveAssistantContent = Boolean(
    latestMessage?.role === "assistant" &&
      latestMessage.parts.some((part) => {
        if (part.type === "text" || part.type === "reasoning") {
          return Boolean(part.text.trim());
        }
        if (part.type === "dynamic-tool") return true;
        return part.type.startsWith("tool-");
      })
  );

  return (
    <div
      ref={scrollRef}
      onScroll={updateShouldAutoScroll}
      className="flex-1 overflow-y-auto px-4 md:px-6"
    >
      <div className="max-w-3xl mx-auto py-4 space-y-1">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {isLoading && messages.length > 0 && !hasLiveAssistantContent && (
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

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  );
}
