"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageBubble } from "./message-bubble";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DictationButton, DictationStatus, useDictation } from "@/components/chat/dictation";
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, MessageCircle, Sparkle, Sparkles, SquareTerminal, TriangleAlert } from "lucide-react";
import type { UIMessage } from "ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { questionPieces } from "@/lib/question-links";
import { DEFER_INTERACTION_ANSWER, type PiPendingInteraction } from "@/lib/pi/interaction-types";
import { ShellRunView } from "@/components/chat/shell-run";
import { useShellActions } from "@/components/chat/shell-actions";
import { useShellRuns, type ShellCard } from "@/store/shell-runs";
import { splitAtSteers, SteerBubble, steerStateOf, type SteerView } from "@/components/chat/steer-bubble";

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

/**
 * What the last message shows, folded into one string that changes whenever
 * anything on screen moves: text growing, a tool card starting or ending.
 */
function visibleProgress(message: UIMessage | undefined): string {
  if (!message) return "";
  let folded = `${message.id}:${message.parts.length}`;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") folded += `|${part.text.length}`;
    else if ("state" in part && typeof part.state === "string") folded += `|${part.state}`;
  }
  return folded;
}

/**
 * The line under a turn that is still going. A reasoning model can think for
 * minutes before its first word, and a line that only said "Thinking..." the
 * whole time read as a hang: people pressed Stop on answers that were coming.
 * It counts the time since anything last appeared and, past a minute, says that
 * this is normal.
 */
function WorkingLine({ progress }: { progress: string }) {
  const { t } = useI18n();
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setSince(Date.now());
  }, [progress]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const elapsed = seconds < 60
    ? t("chat.thinkingSeconds", { seconds })
    : t("chat.thinkingMinutes", { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, "0") });
  return (
    <div className="flex gap-3 py-3" role="status" aria-live="polite">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Loader2 className="size-4 animate-spin" />
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-0.5">
        <span className="text-sm text-muted-foreground">
          {t("chat.thinking")}
          {seconds >= 5 ? <span className="tabular-nums"> {elapsed}</span> : null}
        </span>
        {seconds >= 60 ? (
          <span className="text-xs text-muted-foreground">{t("chat.thinkingLong")}</span>
        ) : null}
      </div>
    </div>
  );
}

interface ChatMessagesProps {
  messages: UIMessage[];
  isLoading: boolean;
  errorMessage?: string | null;
  /** What the person can do about the error, as buttons under it. */
  errorActions?: Array<{ label: string; onClick: () => void }>;
  compactionStatus?: PiCompactionStatus | null;
  actionNotice?: EggentActionNotice | null;
  pendingInteraction?: PiPendingInteraction | null;
  onRespondToInteraction?: (value: string | boolean | null, cancel?: boolean) => void;
  quickSkills?: QuickSkillAction[];
  onLaunchSkill?: (skillName: string) => void;
  launchingSkill?: string | null;
  /** A conversation is open but its stored messages have not arrived yet. */
  awaitingHistory?: boolean;
  /** Messages said to the turn that is working, not read by its agent yet: drawn under the answer. */
  steerQueue?: SteerView[];
  /** Send again a message a turn ended without reading. */
  onResendSteer?: (view: SteerView) => void;
  /** What an empty conversation says instead of the workspace's own welcome: a shared project's, say. */
  empty?: { title: string; description?: string };
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
  // A secret is never spoken aloud, and a terminal prompt wants keystrokes.
  const speakable = interaction.kind === "text" || interaction.kind === "select";
  const appendSpoken = useCallback((text: string) => {
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
  }, []);
  const dictation = useDictation(appendSpoken, !speakable);
  // Options are sentences as often as they are words. A row of chips that
  // cannot wrap ran off the card; long ones read as a list instead, each
  // button the width of the card and wrapping inside itself.
  const longOptions = (interaction.options ?? []).some((option) => option.length > 36);
  const submitDraft = () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    onRespond(value);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{t(interactionKindLabelKey(interaction.kind))}</Badge>
        {heading ? <span className="text-sm text-muted-foreground">{heading}</span> : null}
      </div>

      <p className="whitespace-pre-wrap break-words text-base font-medium leading-6">
        {questionPieces(question).map((piece, index) =>
          piece.kind === "link" ? (
            <a
              key={index}
              href={piece.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {piece.text}
            </a>
          ) : (
            <Fragment key={index}>{piece.text}</Fragment>
          )
        )}
      </p>

      {interaction.options?.length ? (
        <div className={longOptions ? "flex flex-col items-stretch gap-2" : "flex flex-wrap gap-2"}>
          {interaction.options.map((option) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRespond(option)}
              className={cn(
                "h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left leading-5",
                longOptions && "w-full justify-start"
              )}
            >
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
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          <div className="flex items-end gap-2">
            {interaction.kind === "secret" ? (
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={interaction.placeholder || t("chat.interaction.answerPlaceholder")}
                type="password"
                autoFocus
              />
            ) : (
              // Grows with the answer: a dictated one is a paragraph, and a
              // single line hid all but its last few words.
              <Textarea
                value={draft}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submitDraft();
                  }
                }}
                placeholder={
                  interaction.placeholder ||
                  t(interaction.options?.length ? "chat.interaction.orTypeYourOwn" : "chat.interaction.answerPlaceholder")
                }
                className="min-h-9 max-h-40 resize-none py-1.5"
                autoFocus={!interaction.options?.length}
              />
            )}
            {speakable ? <DictationButton dictation={dictation} className="h-9 w-9 rounded-md" /> : null}
            <Button type="submit" size="sm" disabled={!draft.trim()} className="h-9 shrink-0">
              {t("chat.interaction.send")}
            </Button>
          </div>
          <DictationStatus dictation={dictation} />
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

const NO_CARDS: ShellCard[] = [];

const NO_STEERS: SteerView[] = [];

function textOfMessage(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** A command typed behind `!`: it stands in the conversation where it was typed. */
function ShellCardRow({ card }: { card: ShellCard }) {
  return (
    <div className="flex items-start gap-3 py-2" data-message-role="shell">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <SquareTerminal className="size-4" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <ShellRunView runKey={card.key} showCommand alwaysDismissible />
      </div>
    </div>
  );
}

export function ChatMessages({ messages, isLoading, errorMessage, errorActions, compactionStatus, actionNotice, pendingInteraction, onRespondToInteraction, quickSkills = [], onLaunchSkill, launchingSkill, awaitingHistory = false, steerQueue = NO_STEERS, onResendSteer, empty }: ChatMessagesProps) {
  const { t } = useI18n();
  // The answer still being written is cut where its agent read a message said
  // to it. A stored message still waiting to be read is the turn's to show,
  // under the answer, while it works.
  const shown = useMemo(
    () => splitAtSteers(messages).filter((message) => !(isLoading && steerStateOf(message) === "queued")),
    [messages, isLoading]
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const AUTO_SCROLL_THRESHOLD_PX = 96;
  const { chatId } = useShellActions();
  const cards = useShellRuns((state) => state.cards[chatId]) ?? NO_CARDS;
  // Where each command stands: after the message it was typed under. One whose
  // message is not in the list (a chat that was trimmed, or a conversation that
  // has not loaded yet) goes last rather than disappearing.
  const cardsByAnchor = useMemo(() => {
    const known = new Set(messages.map((message) => message.id));
    const grouped = new Map<string | null, ShellCard[]>();
    for (const card of cards) {
      const anchor = card.anchorId && known.has(card.anchorId) ? card.anchorId : card.anchorId === null ? null : "__end__";
      grouped.set(anchor, [...(grouped.get(anchor) ?? []), card]);
    }
    return grouped;
  }, [cards, messages]);

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
  }, [messages, isLoading, cards.length]);

  useEffect(() => {
    updateShouldAutoScroll();
  }, [updateShouldAutoScroll]);

  // The transcript also grows without a new message: a command card fills in
  // as its output arrives, well after the card itself was added. Following only
  // the message list left the output below the fold on the very screen that
  // had just been asked to show it.
  const [transcript, setTranscript] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!transcript || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) endRef.current?.scrollIntoView({ block: "end" });
    });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [transcript]);

  // Whether the transcript is about to replace the skeleton below: then it
  // settles in where the shape stood, instead of the shape blinking into
  // messages. A conversation that starts on this screen had no skeleton and
  // does not fade.
  const showingSkeleton = messages.length === 0 && !isLoading && awaitingHistory;
  const showingEmpty = messages.length === 0 && !isLoading && !awaitingHistory && cards.length === 0;
  const [fromSkeleton, setFromSkeleton] = useState(false);
  if (showingSkeleton && !fromSkeleton) setFromSkeleton(true);
  if (showingEmpty && fromSkeleton) setFromSkeleton(false);

  // A conversation whose messages are still on their way is not an empty one.
  // Switching chats put the new-chat screen on the screen for the half second
  // the fetch took - an invitation to start something, over a conversation that
  // already exists. The same wrapper and the same rhythm as the transcript, so
  // nothing moves when the real messages land.
  if (showingSkeleton) {
    return (
      <div className="flex-1 overflow-y-auto px-4 md:px-6">
        <div className="max-w-3xl mx-auto py-4">
          <SkeletonList rows={3} />
        </div>
      </div>
    );
  }

  if (showingEmpty) {
    return (
      // Scrolls instead of clipping: the quick-start row is taller than a short
      // viewport, and `m-auto` still centres the block when there is room.
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4 md:p-8">
        <div className="m-auto w-full max-w-[min(100vw-2rem,60rem)] min-w-0">
          <div className="flex flex-col items-center text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <MessageCircle className="size-6" />
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight">{empty ? empty.title : t("chat.emptyTitle")}</h2>
            {empty ? (
              empty.description ? <p className="mt-2 max-w-xl text-sm leading-6 whitespace-pre-line text-muted-foreground">{empty.description}</p> : null
            ) : (
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                {/* Without cards (a self-hosted install has none) the line must not promise them. */}
                {quickSkills.length > 0 ? t("chat.emptyDescription") : t("chat.emptyDescriptionPlain")}
              </p>
            )}
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
      <div ref={setTranscript} className={cn("max-w-3xl mx-auto py-4 space-y-1", fromSkeleton && "eggent-surface-in")}>
        {(cardsByAnchor.get(null) ?? NO_CARDS).map((card) => (
          <ShellCardRow key={card.key} card={card} />
        ))}
        {shown.map((message, index) => {
          const steerState = steerStateOf(message);
          // Said to a turn that ended without reading it: drawn as not read, with a way to send it again.
          const unread = steerState === "undelivered" || steerState === "queued";
          return (
            <Fragment key={message.id}>
              {unread ? (
                <SteerBubble
                  view={{ messageId: message.id, text: textOfMessage(message), state: "undelivered" }}
                  onResend={onResendSteer}
                />
              ) : (
                <MessageBubble
                  message={message}
                  // A block still being written is not a command yet: the first
                  // lines of a script are a different script. Run appears once the
                  // message is complete.
                  shellScope={chatId && !(isLoading && index === shown.length - 1) ? `${chatId}:${index}` : undefined}
                />
              )}
              {(cardsByAnchor.get(message.id) ?? NO_CARDS).map((card) => (
                <ShellCardRow key={card.key} card={card} />
              ))}
            </Fragment>
          );
        })}
        {(cardsByAnchor.get("__end__") ?? NO_CARDS).map((card) => (
          <ShellCardRow key={card.key} card={card} />
        ))}

        {steerQueue.map((view) => (
          <SteerBubble key={view.messageId} view={view} />
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
          <WorkingLine progress={visibleProgress(shown[shown.length - 1])} />
        ) : null}

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
            {errorActions && errorActions.length > 0 ? (
              <div className="col-start-2 mt-2 flex flex-wrap gap-2">
                {errorActions.map((action) => (
                  <Button key={action.label} type="button" variant="outline" size="sm" onClick={action.onClick}>
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </Alert>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  );
}
