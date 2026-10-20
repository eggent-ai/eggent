"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SquareKanban } from "lucide-react";
import { statusLabelKey } from "@/components/board/card-sheet";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useI18n } from "@/i18n/provider";
import { fetchCard } from "@/lib/board/client";
import type { BoardCard } from "@/lib/board/types";

/**
 * Above the conversation of a card: that it is one, where it stands on the
 * board, and the way back to it. Writing here is talking to the agent about
 * that card - an answer to its question, a follow-up on its result - and the
 * card follows what the turn comes to.
 */
export function CardChatBanner({ chatId }: { chatId: string }) {
  const { t } = useI18n();
  const tick = useBackgroundSync({ topics: ["board"], chatId, fallbackIntervalMs: 60_000 });
  const [card, setCard] = useState<BoardCard | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCard(chatId)
      .then(({ card: value }) => {
        if (!cancelled) setCard(value);
      })
      .catch(() => {
        if (!cancelled) setCard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, tick]);

  if (!card) return null;
  return (
    <div className="border-b bg-muted/40 px-4 py-2.5 md:px-6">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 text-sm">
        <SquareKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1">
          {t("board.chatBanner")}{" "}
          <span className="text-muted-foreground">{t("board.chatBanner.status", { status: t(statusLabelKey(card)) })}</span>
        </p>
        <Link
          className="shrink-0 font-medium underline-offset-2 hover:underline"
          href={`/dashboard/board?card=${encodeURIComponent(card.id)}`}
        >
          {t("board.chatBanner.open")}
        </Link>
      </div>
    </div>
  );
}
