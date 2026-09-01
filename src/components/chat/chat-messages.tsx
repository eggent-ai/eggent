"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageBubble } from "./message-bubble";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, MessageCircle, Sparkle, Sparkles, TriangleAlert } from "lucide-react";
import type { UIMessage } from "ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { DEFER_INTERACTION_ANSWER, type PiPendingInteraction } from "@/lib/pi/interaction-types";

export interface QuickSkillAction {
  name: string;
  description: string;
  /** Short card copy in the deployment language; falls back to name/description. */
  title?: string;
  summary?: string;
}

export interface PiCompactionStatus {
  state: "running" | "completed" | "failed";
  message: string;
}

export interface EggentActionNotice {
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
}

interface ChatMessagesProps {
  messages: UIMessage[];
  isLoading: boolean;
  errorMessage?: string | null;
  compactionStatus?: PiCompactionStatus | null;
  actionNotice?: EggentActionNotice | null;
  pendingInteraction?: PiPendingInteraction | null;
  onRespondToInteraction?: (value: string | boolean | null, cancel?: boolean) => void;
  quickSkills?: QuickSkillAction[];
  onLaunchSkill?: (skillName: string) => void;
  launchingSkill?: string | null;
  /** A conversation is open but its stored messages have not arrived yet. */
  awaitingHistory?: boolean;
}

function interactionKindLabelKey(kind: PiPendingInteraction["kind"]): MessageKey {
  switch (kind) {
    case "select":
      return "chat.interaction.choose";
    case "confirm":
      return "chat.interaction.confirm";
    case "secret":
      return "chat.interaction.secret";
    case "oauth_url":
      return "chat.interaction.oauth";
    case "device_code":
      return "chat.interaction.deviceCode";
    case "terminal_input":
      return "chat.interaction.terminalInput";
    default:
      return "chat.interaction.input";
  }
}

/**
 * The card the agent asks a question through.
 *
 * It used to show a heading and a generic line telling the user to type into
 * the chat box below; the question itself never arrived, because the bridge it
 * came through carries only a title, and for a typed answer the example sat in
 * the chat placeholder where it read as decoration. Everything now lives in the
 * card: the question, an example, the choices, and an input for typing.
 *
 * Every question also offers a way to hand the decision back. A person who does
 * not know the answer should never have to guess or abandon the flow, and
 * relying on the model to remember that option meant it was often missing.
 */
function InteractionCard({
  interaction,
  onRespond,
}: {
  interaction: PiPendingInteraction;
  onRespond: (value: string | boolean | null, cancel?: boolean) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  // A card with options used to render the buttons and nothing else, so anyone
  // whose answer was not one of four buttons could not answer at all - they
  // typed into the composer and were told "Selected option is not available".
  // The options are the likely answers; they were never meant to be the only
  // ones.
  const acceptsText =
    interaction.kind === "text" ||
    interaction.kind === "secret" ||
    interaction.kind === "terminal_input" ||
    interaction.kind === "select";
  const question = interaction.message?.trim() || interaction.title;
  const heading = interaction.message?.trim() && interaction.title !== interaction.message ? interaction.title : null;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{t(interactionKindLabelKey(interaction.kind))}</Badge>
        {heading ? <span className="text-sm text-muted-foreground">{heading}</span> : null}
      </div>

      <p className="whitespace-pre-wrap text-base font-medium leading-6">{question}</p>

      {interaction.options?.length ? (
        <div className="flex flex-wrap gap-2">
          {interaction.options.map((option) => (
            <Button key={option} type="button" variant="outline" size="sm" onClick={() => onRespond(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : null}

      {interaction.kind === "confirm" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => onRespond(true)}>
            {t("chat.yes")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onRespond(false)}>
            {t("chat.no")}
          </Button>
        </div>
      ) : null}

      {acceptsText ? (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const value = draft.trim();
            if (!value) return;
            setDraft("");
            onRespond(value);
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              interaction.placeholder ||
              t(interaction.options?.length ? "chat.interaction.orTypeYourOwn" : "chat.interaction.answerPlaceholder")
            }
            type={interaction.kind === "secret" ? "password" : "text"}
            autoFocus={!interaction.options?.length}
          />
          <Button type="submit" size="sm" disabled={!draft.trim()} className="sm:w-auto">
            {t("chat.interaction.send")}
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onRespond(DEFER_INTERACTION_ANSWER)}
        >
          {t("chat.interaction.decideForMe")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onRespond(null, true)}
        >
          {t("chat.interaction.skip")}
        </Button>
      </div>
    </div>
  );
}

export function ChatMessages({ messages, isLoading, errorMessage, compactionStatus, actionNotice, pendingInteraction, onRespondToInteraction, quickSkills = [], onLaunchSkill, launchingSkill, awaitingHistory = false }: ChatMessagesProps) {
  const { t } = useI18n();
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

  // A conversation whose messages are still on their way is not an empty one.
  // Switching chats put the new-chat screen on the screen for the half second
  // the fetch took - an invitation to start something, over a conversation that
  // already exists. The same wrapper and the same rhythm as the transcript, so
  // nothing moves when the real messages land.
  if (messages.length === 0 && !isLoading && awaitingHistory) {
    return (
      <div className="flex-1 overflow-y-auto px-4 md:px-6">
        <div className="max-w-3xl mx-auto py-4">
          <SkeletonList rows={3} />
        </div>
      </div>
    );
  }

  if (messages.length === 0 && !isLoading) {
    return (
      // Scrolls instead of clipping: the quick-start row is taller than a short
      // viewport, and `m-auto` still centres the block when there is room.
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4 md:p-8">
        <div className="m-auto w-full max-w-[min(100vw-2rem,60rem)] min-w-0">
          <div className="flex flex-col items-center text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <MessageCircle className="size-6" />
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight">{t("chat.emptyTitle")}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              {t("chat.emptyDescription")}
            </p>
          </div>

          {/*
            The quick-start row is the answer to "what do I do with this?".
            Cards carry short human copy resolved server-side, not the skill's
            own model-facing name and description, and the first one is the
            onboarding skill - so it leads, visually and in the order.
          */}
          {quickSkills.length > 0 ? (
            <div className="mt-8">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">{t("chat.quickStartTitle")}</h3>
                <span className="text-xs text-muted-foreground">{t("chat.quickStartHint")}</span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {quickSkills.map((skill, index) => {
                  const isLaunching = launchingSkill === skill.name;
                  const isLead = index === 0;
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => onLaunchSkill?.(skill.name)}
                      disabled={!onLaunchSkill || Boolean(launchingSkill)}
                      className={cn(
                        "group flex min-h-44 flex-col justify-between rounded-2xl border p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60",
                        isLead ? "border-primary/40 bg-primary/5" : "bg-card"
                      )}
                    >
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div
                            className={cn(
                              "flex size-10 items-center justify-center rounded-xl transition",
                              isLead
                                ? "bg-primary text-primary-foreground"
                                : "bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground"
                            )}
                          >
                            {isLaunching ? <Loader2 className="size-5 animate-spin" /> : isLead ? <Sparkle className="size-5" /> : <Sparkles className="size-5" />}
                          </div>
                          {isLead ? (
                            <Badge variant="secondary" className="shrink-0">{t("chat.startHere")}</Badge>
                          ) : null}
                        </div>
                        <div>
                          <div className="font-semibold leading-tight">{skill.title || skill.name}</div>
                          <p className="mt-1.5 line-clamp-3 text-sm leading-5 text-muted-foreground">
                            {skill.summary || skill.description}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-primary">
                        {isLaunching ? t("chat.startingSkill") : t("chat.setUp")}
                        {isLaunching ? null : <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
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
            <InteractionCard
              interaction={pendingInteraction}
              onRespond={(value, cancel) => onRespondToInteraction?.(value, cancel)}
            />
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

        {actionNotice ? (
          <div className="flex gap-3 py-3">
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-full ${actionNotice.level === "critical" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"}`}>
              <TriangleAlert className="size-4" />
            </div>
            <div className={`flex-1 rounded-lg border p-3 space-y-2 ${actionNotice.level === "critical" ? "border-destructive/40" : "border-warning/40"}`}>
              {actionNotice.title ? <div className="text-sm font-medium">{actionNotice.title}</div> : null}
              {actionNotice.body ? (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{actionNotice.body}</p>
              ) : null}
              {actionNotice.actionUrl ? (
                <Button size="sm" variant={actionNotice.level === "critical" ? "default" : "outline"} asChild>
                  <a href={actionNotice.actionUrl} target="_blank" rel="noreferrer noopener">
                    {actionNotice.actionLabel || t("usage.openAction")}
                    <ExternalLink className="ml-2 size-3.5" />
                  </a>
                </Button>
              ) : null}
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
                {t("chat.thinking")}
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
