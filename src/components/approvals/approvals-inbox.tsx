"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import type { Approval, ApprovalBox } from "@/lib/approvals/types";
import { cn } from "@/lib/utils";
import { approvalsApi } from "./api";
import { ApprovalStatusBadge, approvalPath, useApprovalWords, useWhen } from "./approval-parts";
import { useApprovalsSummary } from "./use-approvals-summary";

const BOXES: ApprovalBox[] = ["waiting", "sent", "involved"];

/** The three boxes of approvals: what waits for the person, what they sent, what they were asked about before. */
export function ApprovalsInbox() {
  const { t } = useI18n();
  const summary = useApprovalsSummary();
  const [box, setBox] = useState<ApprovalBox>("waiting");
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { statusSentence, versionLabel } = useApprovalWords();
  const when = useWhen();

  const load = useCallback(async (which: ApprovalBox) => {
    setError(null);
    try {
      const data = await approvalsApi.list(which);
      setApprovals(data.approvals);
    } catch (failure) {
      setApprovals([]);
      setError(failure instanceof Error ? failure.message : t("approvals.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    setApprovals(null);
    void load(box);
  }, [box, load]);

  if (summary && !summary.enabled) {
    return <p className="text-sm text-muted-foreground">{t("approvals.unavailable")}</p>;
  }

  const count = (which: ApprovalBox) => (which === "waiting" ? (summary?.enabled ? summary.waiting : 0) : which === "sent" ? (summary?.enabled ? summary.returned : 0) : 0);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t("approvals.heading")} className="flex flex-wrap items-center gap-1 border-b">
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
            {t(`approvals.box.${which}`)}
            {count(which) > 0 ? (
              <span className="min-w-5 rounded-full border border-warning px-1.5 text-center text-xs/4 tabular-nums text-foreground">{count(which)}</span>
            ) : null}
          </button>
        ))}
        <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={() => void load(box)} aria-label={t("approvals.refresh")} title={t("approvals.refresh")}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {approvals === null ? (
        <SkeletonList rows={3} />
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : approvals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(`approvals.empty.${box}`)}</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {approvals.map((approval) => (
            <li key={approval.id}>
              <Link href={approvalPath(approval.id)} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{versionLabel(approval.rounds[0], approval.fileName)}</span>
                    <ApprovalStatusBadge approval={approval} />
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {approval.mine ? t("approvals.fromYou") : t("approvals.from", { name: approval.author.name })} · {statusSentence(approval)} · {when(approval.updatedAt)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
