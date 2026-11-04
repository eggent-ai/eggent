"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { AppApprovalCard as Card } from "@/lib/apps/approval-card";

/**
 * Under an answer: changes to a connected service that wait for the person's
 * yes, one line per call. The button opens the deployment's own page, which
 * shows the same calls as it froze them and decides only in a browser it
 * knows as the owner's - this workspace, and its agent, cannot press it.
 */
export function AppApprovalCard({ card }: { card: Card }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 text-sm" data-app-approval>
      <div className="flex items-center gap-2 font-medium">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {card.calls.length > 1 ? t("apps.approval.titleMany", { count: String(card.calls.length) }) : t("apps.approval.title")}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("apps.approval.warning")}</p>
      {card.calls.length ? (
        <ol className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs/5">
          {card.calls.map((line, index) => (
            <li key={`${index}-${line}`} className="min-w-0 break-all">
              {card.calls.length > 1 ? `${index + 1}. ` : ""}
              {line}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button asChild size="sm">
          <a href={card.url} target="_blank" rel="noopener noreferrer">
            {t("apps.approval.open")}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">{t("apps.approval.where")}</span>
      </div>
    </div>
  );
}
