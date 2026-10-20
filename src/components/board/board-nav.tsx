"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SquareKanban } from "lucide-react";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useI18n } from "@/i18n/provider";
import { fetchBoardSummary } from "@/lib/board/client";
import type { BoardSummary } from "@/lib/board/types";
import { cn } from "@/lib/utils";

/**
 * The board's place in the sidebar, under New Chat: the one thing on it that
 * wants the person is a card waiting for them, so that is the number it shows,
 * and a dot while cards are being worked on.
 */
export function BoardNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const tick = useBackgroundSync({ topics: ["board", "global"], fallbackIntervalMs: 60_000 });
  const [summary, setSummary] = useState<BoardSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBoardSummary()
      .then((value) => {
        if (!cancelled) setSummary(value);
      })
      .catch(() => {
        // A count that could not be read is not shown; the board itself says what is wrong.
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const active = pathname.startsWith("/dashboard/board");
  const waiting = summary?.waiting ?? 0;
  return (
    <Link
      href="/dashboard/board"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <SquareKanban aria-hidden className="size-4" />
      <span className="flex-1 truncate">{t("nav.board")}</span>
      {summary && summary.running > 0 ? (
        <span data-eggent-live role="status" aria-label={t("nav.boardWorking")} className="size-2 rounded-full bg-primary" />
      ) : null}
      {waiting > 0 ? (
        <span
          className="min-w-5 rounded-full border border-warning px-1.5 text-center text-xs/4 tabular-nums text-foreground"
          aria-label={t("nav.boardWaiting", { count: waiting })}
          title={t("nav.boardWaiting", { count: waiting })}
        >
          {waiting}
        </span>
      ) : null}
    </Link>
  );
}
