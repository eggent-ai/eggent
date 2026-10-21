"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileText, MessageSquare, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import type { ShareView } from "@/lib/shares/types";
import { cn } from "@/lib/utils";
import { sharedPath, sharesApi } from "./api";
import { ownFilePath, RoleBadge, useShareWhen } from "./share-parts";
import { useSharesSummary } from "./use-shares-summary";

type Box = "withMe" | "mine";
const BOXES: Box[] = ["withMe", "mine"];

/** The two lists of shared files: what colleagues shared with the person, and what the person shared. */
export function SharedInbox() {
  const { t } = useI18n();
  const summary = useSharesSummary();
  const when = useShareWhen();
  const [box, setBox] = useState<Box>("withMe");
  const [lists, setLists] = useState<{ mine: ShareView[]; withMe: ShareView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setLists(await sharesApi.list());
    } catch (failure) {
      setLists({ mine: [], withMe: [] });
      setError(failure instanceof Error ? failure.message : t("shares.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (summary && !summary.enabled) return <p className="text-sm text-muted-foreground">{t("shares.unavailable")}</p>;

  const count = (which: Box) => (summary?.enabled ? (which === "withMe" ? summary.unseen : summary.openOnMine) : 0);
  const shares = lists ? lists[box] : null;

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t("shares.heading")} className="flex flex-wrap items-center gap-1 border-b">
        {BOXES.map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={box === which}
            onClick={() => setBox(which)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              box === which ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t(`shares.box.${which}`)}
            {count(which) > 0 ? (
              <span className="min-w-5 rounded-full border border-info px-1.5 text-center text-xs/4 tabular-nums text-foreground">{count(which)}</span>
            ) : null}
          </button>
        ))}
        <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={() => void load()} aria-label={t("shares.refresh")} title={t("shares.refresh")}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {shares === null ? (
        <SkeletonList rows={3} />
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : shares.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(`shares.empty.${box}`)}</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {shares.map((share) => (
            <li key={share.id} className="flex items-start gap-3 px-4 py-3">
              <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={sharedPath(share.id)} className="truncate text-sm font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none">
                    {share.fileName}
                  </Link>
                  {share.unseen ? <span className="inline-flex shrink-0 items-center rounded-full border border-info px-2 py-0.5 text-xs/4 font-medium text-foreground">{t("shares.new")}</span> : null}
                  {!share.mine ? <RoleBadge role={share.myRole} /> : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>
                    {share.mine
                      ? share.people.length
                        ? t("shares.withPeople", { names: share.people.map((person) => person.name).join(", ") })
                        : t("shares.withNobody")
                      : t("shares.view.from", { name: share.owner.name })}
                  </span>
                  <span>· {when(share.updatedAt)}</span>
                  {share.unresolved ? (
                    <span className="inline-flex items-center gap-1">
                      · <MessageSquare aria-hidden className="size-3" />
                      {t("shares.openComments", { count: share.unresolved })}
                    </span>
                  ) : null}
                  {share.mine && share.fileKey ? (
                    <Link href={ownFilePath(share.fileKey)} className="underline underline-offset-2 hover:text-foreground">{t("shares.openOwn")}</Link>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
