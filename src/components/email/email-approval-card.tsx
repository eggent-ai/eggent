"use client";

import { ExternalLink, Mail, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { EmailApprovalCard as Card } from "@/lib/email/approval-card";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Under an answer: a letter to somebody else that waits for the person's yes,
 * whole, as the deployment froze it. The button is a plain link to the
 * deployment's own page, where only a browser the person remembered there
 * decides - this workspace, and its agent, cannot press it for them.
 */
export function EmailApprovalCard({ card }: { card: Card }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 text-sm" data-email-approval>
      <div className="flex items-center gap-2 font-medium">
        <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {t("email.approval.title")}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("email.approval.warning")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("email.approval.to")}</dt>
        <dd className="min-w-0 break-words">{card.to.join(", ")}</dd>
        <dt className="text-muted-foreground">{t("email.approval.subject")}</dt>
        <dd className="min-w-0 break-words">{card.subject || t("email.noSubject")}</dd>
      </dl>
      <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 px-3 py-2 text-[14px]/6">{card.text}</div>
      {card.files.length ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {card.files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-1.5">
              <Paperclip className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-all">{file.name}</span>
              <span>({sizeText(file.size)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button asChild size="sm">
          <a href={card.url} target="_blank" rel="noopener noreferrer">
            {t("email.approval.open")}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">{t("email.approval.where")}</span>
      </div>
    </div>
  );
}
