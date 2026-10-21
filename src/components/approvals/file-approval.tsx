"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, RotateCcw, Send, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import type { Approval, FileApprovalStatus } from "@/lib/approvals/types";
import { cn } from "@/lib/utils";
import { approvalsApi } from "./api";
import { ApprovalChain, ApprovalStatusBadge, approvalPath, useApprovalWords } from "./approval-parts";
import { SendForApproval } from "./send-for-approval";
import { refreshApprovalsSummary } from "./use-approvals-summary";

/** A file's approval as its screen reads it, asked again whenever `version` moves (a save, a restore). */
export function useFileApproval(projectId: string, path: string, enabled: boolean, version = 0) {
  const [status, setStatus] = useState<FileApprovalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled || !path) return;
    try {
      setStatus(await approvalsApi.file(projectId, path));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "failed");
    }
  }, [enabled, path, projectId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  return { status, error, reload: load, setStatus };
}

/** A line over a file that is on approval or approved: what saving a change to it does. */
export function FileApprovalNotice({ status, className }: { status: FileApprovalStatus | null; className?: string }) {
  const { t } = useI18n();
  const approval = status?.approval;
  if (!approval || !approval.mine) return null;
  const standing = approval.status === "active" || (approval.status === "approved" && !approval.rounds[0]?.voidedAt);
  if (!standing) return null;
  return (
    <div role="status" className={cn("border-l-2 border-warning px-3 py-1.5 text-xs text-foreground", className)}>
      {approval.status === "active" ? t("approvals.notice.onApproval") : t("approvals.notice.approved")}{" "}
      <Link href={approvalPath(approval.id)} className="underline underline-offset-2">{t("approvals.open")}</Link>
    </div>
  );
}

/**
 * A file and its approval, beside the file: how it stands and what can be
 * done about it, or the form to send it for approval.
 */
export function FileApproval({ projectId, path, fill = false, version = 0 }: { projectId: string; path: string; fill?: boolean; version?: number }) {
  const { t } = useI18n();
  const { status, error, reload, setStatus } = useFileApproval(projectId, path, true, version);
  const { statusSentence, versionLabel } = useApprovalWords();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<"resend" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setChoosing(false);
    setActionError(null);
  }, [path]);

  const afterSend = (approval: Approval) => {
    setChoosing(false);
    setStatus((current) => (current ? { ...current, approval, changedSinceSent: false } : current));
    void reload();
  };

  const resend = async (approval: Approval) => {
    const chain = (approval.rounds[0]?.steps ?? []).filter((step) => !step.person.gone).map((step) => step.person.id);
    if (!chain.length) {
      setChoosing(true);
      return;
    }
    setBusy("resend");
    setActionError(null);
    try {
      afterSend(await approvalsApi.send({ project: projectId, path, approvers: chain }));
      void refreshApprovalsSummary();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("approvals.sendFailed"));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (approval: Approval) => {
    if (!window.confirm(t("approvals.withdrawConfirm"))) return;
    setBusy("cancel");
    setActionError(null);
    try {
      await approvalsApi.cancel(approval.id);
      void refreshApprovalsSummary();
      await reload();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("approvals.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const wrap = (body: ReactNode) => <div className={fill ? "h-full overflow-y-auto p-3" : "space-y-3"}>{body}</div>;

  if (!status) return wrap(error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <SkeletonList rows={2} />);
  if (!status.enabled) return wrap(<p className="text-sm text-muted-foreground">{t("approvals.unavailable")}</p>);

  const approval = status.approval && status.approval.status !== "cancelled" ? status.approval : null;
  const latest = approval?.rounds[0];
  const cannotSend = !status.current.exists
    ? t("approvals.file.missing")
    : status.current.tooLarge
      ? t("approvals.file.tooLarge", { maxMb: status.maxBytes / 1024 / 1024 })
      : null;

  if (!approval || choosing) {
    return wrap(
      <div className="space-y-3">
        {!approval ? <p className="text-sm text-muted-foreground">{t("approvals.file.none")}</p> : null}
        {cannotSend ? (
          <p className="text-sm text-muted-foreground">{cannotSend}</p>
        ) : (
          <SendForApproval
            projectId={projectId}
            path={path}
            initialChain={choosing && latest ? latest.steps.map((step) => step.person.id) : []}
            submitLabel={approval ? t("approvals.form.sendAgain") : undefined}
            onSent={afterSend}
            onCancel={choosing ? () => setChoosing(false) : undefined}
          />
        )}
      </div>
    );
  }

  const returnedOrOutdated = approval.status === "rejected" || approval.status === "outdated";
  return wrap(
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{versionLabel(latest, approval.fileName)}</span>
        <ApprovalStatusBadge approval={approval} />
      </div>
      <p className="text-sm">{statusSentence(approval)}</p>
      {approval.status === "active" ? <p className="text-xs text-muted-foreground">{t("approvals.file.activeRule")}</p> : null}
      {approval.status === "approved" && !latest?.voidedAt ? <p className="text-xs text-muted-foreground">{t("approvals.file.approvedRule")}</p> : null}
      {returnedOrOutdated && !status.changedSinceSent ? <p className="text-xs text-muted-foreground">{t("approvals.file.unchangedSinceSent")}</p> : null}
      {latest ? <ApprovalChain round={latest} /> : null}
      {latest?.note ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{latest.note}</p> : null}
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      <div className="flex flex-wrap gap-2 pt-1">
        {returnedOrOutdated && !cannotSend ? (
          <Button size="sm" onClick={() => void resend(approval)} disabled={busy !== null} className="gap-1.5" variant={status.changedSinceSent ? "default" : "outline"}>
            {busy === "resend" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            {status.changedSinceSent ? t("approvals.file.sendNew") : t("approvals.file.sendSame")}
          </Button>
        ) : null}
        {(returnedOrOutdated || approval.status === "active") && !cannotSend ? (
          <Button size="sm" variant="outline" onClick={() => setChoosing(true)} disabled={busy !== null} className="gap-1.5">
            <Users className="size-3.5" />
            {t("approvals.file.otherPeople")}
          </Button>
        ) : null}
        {approval.status === "active" ? (
          <Button size="sm" variant="ghost" onClick={() => void withdraw(approval)} disabled={busy !== null} className="gap-1.5">
            {busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            {t("approvals.withdraw")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" asChild className="gap-1.5">
          <Link href={approvalPath(approval.id)}>
            <ArrowUpRight className="size-3.5" />
            {t("approvals.open")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
