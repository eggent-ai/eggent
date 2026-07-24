"use client";

import { useCallback, useEffect, useRef } from "react";
import { MessageBubble } from "./message-bubble";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { CheckCircle2, Loader2, MessageCircle, Sparkles, TriangleAlert } from "lucide-react";
import type { UIMessage } from "ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";

export interface QuickSkillAction {
  name: string;
  description: string;
}

export interface PiCompactionStatus {
  state: "running" | "completed" | "failed";
  message: string;
}

interface ChatMessagesProps {
  messages: UIMessage[];
  isLoading: boolean;
  errorMessage?: string | null;
  compactionStatus?: PiCompactionStatus | null;
  pendingInteraction?: PiPendingInteraction | null;
  onRespondToInteraction?: (value: string | boolean | null, cancel?: boolean) => void;
  quickSkills?: QuickSkillAction[];
  onLaunchSkill?: (skillName: string) => void;
  launchingSkill?: string | null;
}

function interactionKindLabel(kind: PiPendingInteraction["kind"]): string {
  switch (kind) {
    case "select":
      return "Choose";
    case "confirm":
      return "Confirm";
    case "secret":
      return "Secret";
    case "oauth_url":
      return "OAuth";
    case "device_code":
      return "Device code";
    case "terminal_input":
      return "Terminal input";
    default:
      return "Input";
  }
}

export function ChatMessages({ messages, isLoading, errorMessage, compactionStatus, pendingInteraction, onRespondToInteraction, quickSkills = [], onLaunchSkill, launchingSkill }: ChatMessagesProps) {
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
      <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden p-4 md:p-8">
        <Empty className="min-w-0 border-none px-0 md:px-0">
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
            <div className="relative mt-6 w-full max-w-[min(100vw-2rem,56rem)] min-w-0">
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background via-background/80 to-transparent backdrop-blur-[1px]" />
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background via-background/80 to-transparent backdrop-blur-[1px]" />
              <div
                className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-6 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                aria-label="Bundled skills"
              >
                {quickSkills.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    onClick={() => onLaunchSkill?.(skill.name)}
                    disabled={!onLaunchSkill || Boolean(launchingSkill)}
                    className="group flex min-h-40 w-[min(18rem,78vw)] flex-none snap-center flex-col justify-between rounded-2xl border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="space-y-3">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
                        {launchingSkill === skill.name ? <Loader2 className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
                      </div>
                      <div>
                        <div className="font-semibold leading-tight">{skill.name}</div>
                        <p className="mt-2 line-clamp-3 text-sm leading-5 text-muted-foreground">{skill.description}</p>
                      </div>
                    </div>
                    <div className="mt-4 text-xs font-medium text-primary">
                      {launchingSkill === skill.name ? "Creating project…" : "Set up"}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </Empty>
      </div>
    );
  }

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


        {pendingInteraction ? (
          <div className="flex gap-3 py-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Loader2 className="size-4 animate-spin" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{interactionKindLabel(pendingInteraction.kind)}</Badge>
                <span className="text-sm font-medium">Eggent is waiting for input</span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{pendingInteraction.title}</p>
                {pendingInteraction.message ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{pendingInteraction.message}</p>
                ) : null}
              </div>
              {pendingInteraction.kind === "select" && pendingInteraction.options?.length ? (
                <div className="flex flex-wrap gap-2">
                  {pendingInteraction.options.map((option) => (
                    <Button
                      key={option}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRespondToInteraction?.(option)}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              ) : null}
              {pendingInteraction.kind === "confirm" ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" onClick={() => onRespondToInteraction?.(true)}>
                    Yes
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => onRespondToInteraction?.(false)}>
                    No
                  </Button>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {pendingInteraction.kind === "select"
                  ? "Choose an option above or type the exact value below."
                  : pendingInteraction.kind === "confirm"
                    ? "Choose Yes/No above, or type a response below."
                    : "Type your response in the chat box below. It will be sent to the waiting tool, not to the model."}
              </p>
            </div>
          </div>
        ) : null}

        {compactionStatus ? (
          <div className="flex gap-3 py-3">
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-full ${compactionStatus.state === "failed" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>
              {compactionStatus.state === "running" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : compactionStatus.state === "failed" ? (
                <TriangleAlert className="size-4" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
            </div>
            <div className="flex items-center">
              <span className="text-sm text-muted-foreground">
                {compactionStatus.message}
              </span>
            </div>
          </div>
        ) : null}

        {isLoading && messages.length > 0 && !compactionStatus && !pendingInteraction ? (
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
        ) : null}

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
