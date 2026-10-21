"use client";

import { Check, Circle, Clock, Minus, Undo2 } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { Approval, ApprovalRound, ApprovalStatus, ApprovalStep } from "@/lib/approvals/types";
import { cn } from "@/lib/utils";

/**
 * The pieces every approvals screen is made of: how an approval stands, said
 * in a word and in a sentence, and its chain of people in order.
 *
 * Colour marks a state on the border and the icon; the words keep the text
 * colour, because a semantic colour does not carry text on a wash of itself.
 */

export function approvalPath(id: string): string {
  return `/dashboard/approvals/${encodeURIComponent(id)}`;
}

/** The orchestrator's view of a file, by its path under the projects folder: every file has one. */
export function filePathOfKey(key: string): string {
  return `/dashboard/files?${new URLSearchParams({ project: "none", path: key }).toString()}`;
}

const BADGE_BORDER: Record<ApprovalStatus, string> = {
  active: "border-warning",
  approved: "border-success",
  rejected: "border-destructive",
  outdated: "border-border",
  cancelled: "border-border",
};

export function useApprovalWords() {
  const { t } = useI18n();
  const versionLabel = (round: Pick<ApprovalRound, "fileName" | "versionN"> | undefined, fileName: string) =>
    round?.versionN ? t("approvals.versionOf", { file: round.fileName || fileName, n: round.versionN }) : round?.fileName || fileName;

  /** The status in a word or two, as a badge says it. */
  const statusWord = (approval: Approval): string => {
    if (approval.status === "active") return approval.myTurn ? t("approvals.status.yourTurn") : t("approvals.status.active");
    if (approval.status === "approved") return approval.rounds[0]?.voidedAt ? t("approvals.status.approvedChanged") : t("approvals.status.approved");
    if (approval.status === "rejected") return t("approvals.status.rejected");
    if (approval.status === "outdated") return t("approvals.status.outdated");
    return t("approvals.status.cancelled");
  };

  /** The status as a sentence: who it waits for, who returned it, what voided it. */
  const statusSentence = (approval: Approval): string => {
    const latest = approval.rounds[0];
    if (approval.superseded) return t("approvals.line.superseded");
    if (approval.status === "active") {
      if (approval.myTurn) return t("approvals.line.yourTurn");
      return approval.waitingFor
        ? approval.waitingFor.gone
          ? t("approvals.line.waitingGone", { name: approval.waitingFor.name })
          : t("approvals.line.waiting", { name: approval.waitingFor.name })
        : t("approvals.status.active");
    }
    if (approval.status === "approved") return latest?.voidedAt ? t("approvals.line.approvedChanged") : t("approvals.line.approved");
    if (approval.status === "rejected") {
      const by = latest?.steps.find((step) => step.state === "rejected")?.person.name;
      return by ? t("approvals.line.rejectedBy", { name: by }) : t("approvals.status.rejected");
    }
    if (approval.status === "outdated") return t("approvals.line.outdated");
    return t("approvals.line.cancelled");
  };

  return { versionLabel, statusWord, statusSentence };
}

export function ApprovalStatusBadge({ approval, className }: { approval: Approval; className?: string }) {
  const { statusWord } = useApprovalWords();
  const status: ApprovalStatus = approval.status === "approved" && approval.rounds[0]?.voidedAt ? "outdated" : approval.status;
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs/4 font-medium text-foreground", BADGE_BORDER[status], className)}>
      {statusWord(approval)}
    </span>
  );
}

function StepIcon({ step }: { step: ApprovalStep }) {
  if (step.state === "approved") return <Check aria-hidden className="size-4 text-success" />;
  if (step.state === "rejected") return <Undo2 aria-hidden className="size-4 text-destructive" />;
  if (step.state === "skipped") return <Minus aria-hidden className="size-4 text-muted-foreground" />;
  if (step.current) return <Clock aria-hidden className="size-4 text-warning" />;
  return <Circle aria-hidden className="size-3.5 text-muted-foreground" />;
}

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** The people of one round, in the order they decide, with what each decided and said. */
export function ApprovalChain({ round, compact = false }: { round: ApprovalRound; compact?: boolean }) {
  const { t, locale } = useI18n();
  const stateWord = (step: ApprovalStep) => {
    if (step.state === "approved") return t("approvals.step.approved");
    if (step.state === "rejected") return t("approvals.step.rejected");
    if (step.state === "skipped") return t("approvals.step.skipped");
    return step.current ? t("approvals.step.current") : t("approvals.step.pending");
  };
  return (
    <ol className="space-y-2" aria-label={t("approvals.chain.label")}>
      {round.steps.map((step) => (
        <li key={step.position} className={cn("flex gap-2.5", step.current && "font-medium")}>
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
            <StepIcon step={step} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="truncate">
                {step.position + 1}. {step.person.name}
                {step.person.gone ? <span className="font-normal text-muted-foreground"> · {t("approvals.person.gone")}</span> : null}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {stateWord(step)}
                {step.decidedAt && !compact ? ` · ${formatWhen(step.decidedAt, locale)}` : ""}
                {step.viaAgent ? ` · ${t("approvals.step.viaAgent")}` : ""}
              </span>
            </div>
            {step.comment && !compact ? (
              <p className="mt-1 whitespace-pre-wrap break-words border-l-2 pl-2 text-sm font-normal text-foreground">{step.comment}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function useWhen() {
  const { locale } = useI18n();
  return (iso: string | null) => formatWhen(iso, locale);
}
