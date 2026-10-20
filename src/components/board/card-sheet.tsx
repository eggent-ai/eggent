"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  CheckCheck,
  CircleHelp,
  Cloud,
  Inbox,
  Laptop,
  MessageSquare,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FilesProduced } from "@/components/chat/files-produced";
import { CardForm, type CardFormValues } from "@/components/board/card-form";
import { cardPlace } from "@/components/board/card-place";
import { WAITING_LABEL, clockTime, minutesSince } from "@/components/board/card-tile";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { chatPath } from "@/lib/dashboard-routes";
import * as board from "@/lib/board/client";
import { waitingFor } from "@/lib/board/logic";
import type { BoardCard, CardRunOutcome, CardStatus } from "@/lib/board/types";
import { isDeviceHome, type ChatHome, type RemoteStatus } from "@/lib/remote/types";
import type { Project } from "@/lib/types";

const STATUS_LABEL: Record<CardStatus, MessageKey> = {
  inbox: "board.column.inbox",
  queued: "board.column.queued",
  running: "board.column.running",
  waiting: "board.column.waiting",
  done: "board.column.done",
};

const OUTCOME_LABEL: Record<CardRunOutcome, MessageKey> = {
  done: "board.outcome.done",
  question: "board.outcome.question",
  failed: "board.outcome.failed",
  stalled: "board.outcome.stalled",
  stopped: "board.outcome.stopped",
  refused: "board.outcome.refused",
  interrupted: "board.outcome.interrupted",
};

/**
 * The result as the chat would show it, without the chat's own machinery (file
 * links, runnable code): a card is read here, and worked with in its chat.
 * Defined once, outside the component, so a re-render does not remount it.
 */
const RESULT_MARKDOWN: Components = {
  p: ({ node: _node, ...props }) => <p className="my-2" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1 pl-6" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-6" {...props} />,
  li: ({ node: _node, ...props }) => <li className="marker:text-muted-foreground" {...props} />,
  h1: ({ node: _node, ...props }) => <h4 className="mt-3 mb-1 font-semibold" {...props} />,
  h2: ({ node: _node, ...props }) => <h4 className="mt-3 mb-1 font-semibold" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 className="mt-3 mb-1 font-semibold" {...props} />,
  a: ({ node: _node, href, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground" {...props} />
  ),
  code: ({ node: _node, className, ...props }) =>
    /language-/.test(className || "") ? (
      <code className={className} {...props} />
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]" {...props} />
    ),
  pre: ({ node: _node, ...props }) => <pre className="my-2 overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border-b px-2 py-1 text-left font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border-b px-2 py-1 align-top" {...props} />,
};

export function statusLabelKey(card: BoardCard): MessageKey {
  if (card.archived) return "board.column.archived";
  if (card.status === "waiting" && card.waiting) return WAITING_LABEL[card.waiting.reason];
  return STATUS_LABEL[card.status];
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? clockTime(iso) : `${date.getDate()}.${String(date.getMonth() + 1).padStart(2, "0")} ${clockTime(iso)}`;
}

/**
 * One card, opened: what it was asked, what it came to, what it waits for, and
 * the moves open to it from where it is. Everything it did is in its chat; this
 * is the card's face, and the way to that chat.
 */
export function CardSheet({
  card,
  cards,
  live,
  projects,
  node,
  remote,
  now,
  onClose,
  onChanged,
  onMoveWithin,
}: {
  card: BoardCard | null;
  cards: BoardCard[];
  live?: { startedAt: number; question: boolean };
  projects: Project[];
  /** This side, in a pair; null where there is none. */
  node: ChatHome | null;
  remote: RemoteStatus | null;
  now: number;
  onClose: () => void;
  onChanged: () => void;
  onMoveWithin: (card: BoardCard, direction: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    setEditing(false);
    setError(null);
    setAnswer("");
  }, [card?.id]);

  const byId = new Map(cards.map((other) => [other.id, other]));
  const act = async (work: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
      if (closeAfter) onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const open = Boolean(card);
  const running = card ? card.status === "running" || Boolean(live) : false;
  const pending = card ? waitingFor(card, byId) : [];
  const projectName = (id?: string) => (id ? projects.find((project) => project.id === id)?.name ?? id : t("nav.orchestrator"));
  const place = card ? cardPlace(card.home, node, remote, t) : null;

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {card ? (
          <>
            <SheetHeader className="gap-1 border-b p-4 pr-12">
              <SheetTitle className="text-base leading-snug">{card.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  {running ? <span data-eggent-live aria-hidden className="size-2 rounded-full bg-primary" /> : null}
                  {running && live ? t("board.card.working", { minutes: minutesSince(live.startedAt, now) }) : t(statusLabelKey(card))}
                </span>
                <span aria-hidden>·</span>
                <span>{projectName(card.projectId)}</span>
                {place ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1" data-testid="card-sheet-place">
                      {place.kind === "cloud" ? <Cloud aria-hidden className="size-3.5" /> : <Laptop aria-hidden className="size-3.5" />}
                      {place.away ? t("board.card.deviceAway", { name: place.name }) : place.name}
                    </span>
                  </>
                ) : null}
                {card.createdBy === "agent" ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>{card.createdFrom?.title ? t("board.sheet.from", { chat: card.createdFrom.title }) : t("board.card.byAgent")}</span>
                  </>
                ) : null}
              </SheetDescription>
              {/* Up here, not in the footer: the hosted workspace's help button sits over the bottom-right corner. */}
              {card.runs.length > 0 ? (
                <Link
                  href={chatPath(card.id)}
                  className="mt-1 inline-flex w-fit items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline"
                >
                  <MessageSquare aria-hidden className="size-4" />
                  {t("board.sheet.openChat")}
                </Link>
              ) : null}
            </SheetHeader>

            <div className="flex flex-col gap-5 p-4">
              {editing ? (
                <CardForm
                  initial={{
                    title: card.title,
                    body: card.body,
                    projectId: card.projectId ?? null,
                    after: card.after ?? [],
                    review: Boolean(card.review),
                    home: card.home ?? null,
                  }}
                  cards={cards}
                  editingId={card.id}
                  projects={projects}
                  projectLocked={card.runs.length > 0}
                  remote={remote}
                  busy={busy}
                  error={error}
                  onCancel={() => setEditing(false)}
                  onSubmit={(values: CardFormValues) =>
                    act(async () => {
                      await board.editCard(card.id, values);
                      setEditing(false);
                    })
                  }
                />
              ) : (
                <>
                  {card.status === "waiting" && card.waiting?.reason === "question" && card.question ? (
                    <section aria-labelledby={`q-${card.id}`} className="space-y-2 rounded-lg border border-warning p-3">
                      <h3 id={`q-${card.id}`} className="flex items-center gap-1.5 text-sm font-medium">
                        <CircleHelp aria-hidden className="size-4" />
                        {t("board.sheet.question")}
                      </h3>
                      <p className="whitespace-pre-wrap text-sm">{card.question.text}</p>
                      {card.question.options?.length ? (
                        <div className="flex flex-wrap gap-2">
                          {card.question.options.map((option) => (
                            <Button key={option} type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(() => board.answerCard(card.id, option))}>
                              {option}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                      <form
                        className="flex flex-col gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (answer.trim()) void act(() => board.answerCard(card.id, answer));
                        }}
                      >
                        <Textarea
                          value={answer}
                          rows={3}
                          placeholder={card.question.placeholder || t("board.sheet.answerPlaceholder")}
                          aria-label={t("board.sheet.answerPlaceholder")}
                          onChange={(event) => setAnswer(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && answer.trim()) {
                              event.preventDefault();
                              void act(() => board.answerCard(card.id, answer));
                            }
                          }}
                        />
                        <div className="flex justify-end">
                          <Button type="submit" size="sm" disabled={busy || !answer.trim()}>
                            {t("board.sheet.sendAnswer")}
                          </Button>
                        </div>
                      </form>
                    </section>
                  ) : null}

                  {card.status === "waiting" && card.waiting?.detail ? (
                    <section className="space-y-1">
                      <h3 className="text-sm font-medium">{t("board.sheet.waitingDetail")}</h3>
                      <p className="whitespace-pre-wrap rounded-md border px-3 py-2 text-sm text-muted-foreground">{card.waiting.detail}</p>
                    </section>
                  ) : null}

                  {pending.length > 0 ? (
                    <p className="text-sm text-muted-foreground">{t("board.card.after", { titles: pending.map((parent) => parent.title).join(", ") })}</p>
                  ) : null}

                  <section className="space-y-1">
                    <h3 className="text-sm font-medium">{t("board.sheet.task")}</h3>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{card.body || card.title}</p>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t("board.sheet.result")}</h3>
                    {card.result && (card.result.text.trim() || card.result.files?.length) ? (
                      <>
                        {card.result.text.trim() ? (
                          <div className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={RESULT_MARKDOWN}>
                              {card.result.text}
                            </ReactMarkdown>
                          </div>
                        ) : null}
                        {card.result.truncated ? <p className="text-xs text-muted-foreground">{t("board.sheet.resultTruncated")}</p> : null}
                        {card.result.files?.length ? <FilesProduced groups={card.result.files} /> : null}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("board.sheet.noResult")}</p>
                    )}
                  </section>

                  {card.runs.length > 0 ? (
                    <section className="space-y-1">
                      <h3 className="text-sm font-medium">{t("board.sheet.runs")}</h3>
                      <ol className="space-y-0.5 text-xs/5 text-muted-foreground">
                        {[...card.runs].reverse().slice(0, 8).map((run) => (
                          <li key={run.id} className="flex flex-wrap gap-x-1.5">
                            <span className="tabular-nums">{shortDate(run.startedAt)}</span>
                            <span className="text-foreground">{t(run.outcome ? OUTCOME_LABEL[run.outcome] : "board.outcome.running")}</span>
                            <span>{t(`board.surface.${run.surface}` as MessageKey)}</span>
                            {isDeviceHome(run.node) ? <span>{t("board.run.place", { place: cardPlace(run.node, node, remote, t)?.name ?? t("chat.runPlace.yourComputer") })}</span> : null}
                            {run.detail ? <span className="w-full truncate" title={run.detail}>{run.detail}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}

                  {error ? (
                    <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm text-foreground">
                      {error}
                    </p>
                  ) : null}
                </>
              )}
            </div>

            {!editing ? (
              <div className="mt-auto flex flex-wrap gap-2 border-t p-4">
                <CardActions
                  card={card}
                  running={running}
                  busy={busy}
                  act={act}
                  onEdit={() => setEditing(true)}
                  onMoveWithin={onMoveWithin}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CardActions({
  card,
  running,
  busy,
  act,
  onEdit,
  onMoveWithin,
}: {
  card: BoardCard;
  running: boolean;
  busy: boolean;
  act: (work: () => Promise<unknown>, closeAfter?: boolean) => Promise<void>;
  onEdit: () => void;
  onMoveWithin: (card: BoardCard, direction: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const remove = () => {
    if (!window.confirm(t("board.action.deleteConfirm", { title: card.title }))) return;
    void act(() => board.deleteCard(card.id), true);
  };

  if (running) {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => board.stopCard(card.id))}>
        <Square aria-hidden />
        {t("board.action.stop")}
      </Button>
    );
  }

  if (card.archived) {
    return (
      <>
        <Button size="sm" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "unarchived"))}>
          <ArchiveRestore aria-hidden />
          {t("board.action.unarchive")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
          <Trash2 aria-hidden />
          {t("board.action.delete")}
        </Button>
      </>
    );
  }

  const edit = (
    <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
      <Pencil aria-hidden />
      {t("board.action.edit")}
    </Button>
  );
  const del = (
    <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
      <Trash2 aria-hidden />
      {t("board.action.delete")}
    </Button>
  );
  const order = (
    <>
      <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={t("board.action.moveUp")} title={t("board.action.moveUp")} onClick={() => onMoveWithin(card, -1)}>
        <ArrowUp aria-hidden />
      </Button>
      <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={t("board.action.moveDown")} title={t("board.action.moveDown")} onClick={() => onMoveWithin(card, 1)}>
        <ArrowDown aria-hidden />
      </Button>
    </>
  );

  switch (card.status) {
    case "inbox":
      return (
        <>
          <Button size="sm" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "queued"))}>
            <Play aria-hidden />
            {t("board.action.start")}
          </Button>
          {edit}
          {order}
          {del}
        </>
      );
    case "queued":
      return (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "inbox"))}>
            <Inbox aria-hidden />
            {t("board.action.toInbox")}
          </Button>
          {edit}
          {order}
          {del}
        </>
      );
    case "waiting":
      return (
        <>
          {card.waiting?.reason === "review" ? (
            <Button size="sm" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "done"))}>
              <CheckCheck aria-hidden />
              {t("board.action.accept")}
            </Button>
          ) : null}
          {card.waiting?.reason === "question" ? (
            // The answer above is the way on; this is for a question the person would rather leave to the agent.
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "queued"))}>
              <Play aria-hidden />
              {t("board.action.decide")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={card.waiting?.reason === "review" ? "outline" : "default"}
              disabled={busy}
              onClick={() => act(() => board.moveCard(card.id, "queued"))}
            >
              {card.waiting?.reason === "stopped" || card.waiting?.reason === "interrupted" ? <Play aria-hidden /> : <RotateCcw aria-hidden />}
              {card.waiting?.reason === "stopped" || card.waiting?.reason === "interrupted" ? t("board.action.continue") : t("board.action.retry")}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "inbox"))}>
            <Inbox aria-hidden />
            {t("board.action.toInbox")}
          </Button>
          {edit}
          {del}
        </>
      );
    case "done":
      return (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "queued"))}>
            <RotateCcw aria-hidden />
            {t("board.action.retry")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => board.moveCard(card.id, "archived"), true)}>
            <Archive aria-hidden />
            {t("board.action.archive")}
          </Button>
          {del}
        </>
      );
    default:
      return null;
  }
}
