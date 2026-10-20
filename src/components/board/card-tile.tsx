"use client";

import { CircleHelp, Clock, Hourglass, Laptop, OctagonAlert, Sparkles } from "lucide-react";
import type { CardPlace } from "@/components/board/card-place";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { waitingFor } from "@/lib/board/logic";
import type { BoardCard, WaitingReason } from "@/lib/board/types";
import { cn } from "@/lib/utils";

export const WAITING_LABEL: Record<WaitingReason, MessageKey> = {
  question: "board.waiting.question",
  failed: "board.waiting.failed",
  stalled: "board.waiting.stalled",
  stopped: "board.waiting.stopped",
  refused: "board.waiting.refused",
  review: "board.waiting.review",
  interrupted: "board.waiting.interrupted",
};

/** The colour of a waiting reason goes on the border, never under its text: see the design notes on semantic colour. */
export function waitingTone(reason: WaitingReason): string {
  if (reason === "question" || reason === "review") return "border-warning";
  if (reason === "stopped") return "border-border";
  return "border-destructive";
}

/**
 * The first line of a result worth reading on a tile: an answer usually opens
 * with a heading, and "## Done" says nothing a column does not already say.
 */
export function resultPreview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || line.startsWith("```")) continue;
    const plain = line
      .replace(/^[-*+]\s+|^\d+[.)]\s+|^>\s*/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .trim();
    if (plain) return plain;
  }
  return undefined;
}

export function minutesSince(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function CardTile({
  card,
  byId,
  live,
  projectName,
  place,
  now,
  draggable,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  byId: Map<string, BoardCard>;
  live?: { startedAt: number; question: boolean };
  /** Shown when the board shows more than one project. */
  projectName?: string | null;
  /** Where it runs, in a pair. Only a computer is marked: the cloud is where a card runs unless somebody says otherwise. */
  place?: CardPlace | null;
  now: number;
  draggable: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t } = useI18n();
  const pending = card.status === "queued" || card.status === "inbox" ? waitingFor(card, byId) : [];
  const resultLine = card.status === "done" ? resultPreview(card.result?.text) : undefined;
  const working = card.status === "running" || Boolean(live);

  return (
    <li
      data-card-id={card.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group/card relative rounded-lg border bg-card text-card-foreground shadow-xs transition-[box-shadow,opacity,border-color] duration-150",
        draggable && "cursor-grab active:cursor-grabbing",
        "hover:shadow-sm focus-within:shadow-sm",
        card.status === "waiting" && card.waiting ? waitingTone(card.waiting.reason) : "border-border",
        dragging && "opacity-40"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("board.card.open", { title: card.title })}
        className="flex w-full cursor-[inherit] flex-col gap-1.5 rounded-lg p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <span className="line-clamp-2 text-sm font-medium leading-snug">{card.title}</span>

        {resultLine ? <span className="line-clamp-2 text-xs/4 text-muted-foreground">{resultLine}</span> : null}

        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs/4 text-muted-foreground">
          {working ? (
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <span data-eggent-live aria-hidden className="size-2 rounded-full bg-primary" />
              {live ? t("board.card.working", { minutes: minutesSince(live.startedAt, now) }) : t("board.card.workingNow")}
            </span>
          ) : null}
          {live?.question ? (
            <span className="inline-flex items-center gap-1 text-foreground">
              <CircleHelp aria-hidden className="size-3.5" />
              {t("board.card.asked")}
            </span>
          ) : null}
          {card.status === "waiting" && card.waiting ? (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              {card.waiting.reason === "question" ? <CircleHelp aria-hidden className="size-3.5" /> : <OctagonAlert aria-hidden className="size-3.5" />}
              {t(WAITING_LABEL[card.waiting.reason])}
            </span>
          ) : null}
          {pending.length > 0 ? (
            <span className="inline-flex items-center gap-1" title={t("board.card.after", { titles: pending.map((parent) => parent.title).join(", ") })}>
              <Hourglass aria-hidden className="size-3.5" />
              {t("board.card.waitsFor", { count: pending.length })}
            </span>
          ) : null}
          {card.status === "queued" && card.retryAt && Date.parse(card.retryAt) > now ? (
            <span className="inline-flex items-center gap-1">
              <Clock aria-hidden className="size-3.5" />
              {t("board.card.retryAt", { time: clockTime(card.retryAt) })}
            </span>
          ) : null}
          {card.review && card.status !== "done" ? <span>{t("board.card.review")}</span> : null}
          {projectName ? <span className="truncate">{projectName}</span> : null}
          {place?.kind === "device" ? (
            // Wraps rather than truncates: in a narrow column "is away" is the part that matters.
            <span className="inline-flex min-w-0 items-start gap-1" data-testid="card-place-mark">
              <Laptop aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{place.away && card.status === "queued" ? t("board.card.deviceAway", { name: place.name }) : place.name}</span>
            </span>
          ) : null}
          {card.createdBy === "agent" && card.status === "inbox" ? (
            <span className="inline-flex items-center gap-1" title={card.createdFrom?.title ? t("board.sheet.from", { chat: card.createdFrom.title }) : undefined}>
              <Sparkles aria-hidden className="size-3.5" />
              {t("board.card.byAgent")}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
