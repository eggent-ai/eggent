"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Download, ExternalLink, FileText, Loader2, RotateCcw, Send, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { Textarea } from "@/components/ui/textarea";
import { VersionDiff } from "@/components/files/version-diff";
import { useI18n } from "@/i18n/provider";
import { APPROVAL_MAX_COMMENT_CHARS, type Approval, type ApprovalRound, type FileApprovalStatus } from "@/lib/approvals/types";
import { buildDiff } from "@/lib/files/versions/diff-model";
import { prefersProse } from "@/lib/files/versions/rules";
import { cn } from "@/lib/utils";
import { approvalsApi, opensInBrowser } from "./api";
import { ApprovalChain, ApprovalStatusBadge, filePathOfKey, useApprovalWords, useWhen } from "./approval-parts";
import { refreshApprovalsSummary } from "./use-approvals-summary";

type RoundText = { kind: "text" | "extracted" | "none"; text: string; truncated?: boolean } | "error" | "loading";

/** The text of a round's version, asked for once per round. */
function useRoundTexts(approvalId: string) {
  const [texts, setTexts] = useState<Record<number, RoundText>>({});
  const asked = useRef(new Set<number>());
  const load = useCallback(
    (round: number) => {
      if (asked.current.has(round)) return;
      asked.current.add(round);
      setTexts((current) => ({ ...current, [round]: "loading" }));
      approvalsApi
        .text(approvalId, round)
        .then((answer) => setTexts((current) => ({ ...current, [round]: { kind: answer.kind, text: answer.text, truncated: answer.truncated } })))
        .catch(() => setTexts((current) => ({ ...current, [round]: "error" })));
    },
    [approvalId]
  );
  return { texts, load };
}

/** One approval: the version asked about, what changed since the one before, the chain, and the decision when it is the person's turn. */
export function ApprovalDetail({ approvalId }: { approvalId: string }) {
  const { t } = useI18n();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileStatus, setFileStatus] = useState<FileApprovalStatus | null>(null);
  const [view, setView] = useState<"changes" | "text">("changes");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | "resend" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { statusSentence, versionLabel } = useApprovalWords();
  const when = useWhen();
  const { texts, load: loadText } = useRoundTexts(approvalId);

  const load = useCallback(async () => {
    try {
      const next = await approvalsApi.detail(approvalId);
      setApproval(next);
      setError(null);
      if (next.mine && next.fileKey && next.status !== "cancelled") {
        approvalsApi.file("none", next.fileKey).then(setFileStatus).catch(() => setFileStatus(null));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("approvals.loadFailed"));
    }
  }, [approvalId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = approval?.rounds[0];
  const previous = approval?.rounds[1];
  useEffect(() => {
    if (!latest) return;
    loadText(latest.round);
    if (previous) loadText(previous.round);
  }, [latest, previous, loadText]);

  const latestText = latest ? texts[latest.round] : undefined;
  const previousText = previous ? texts[previous.round] : undefined;
  const model = useMemo(() => {
    if (!previous || !latestText || !previousText || typeof latestText === "string" || typeof previousText === "string") return null;
    if (latestText.kind === "none" || previousText.kind === "none") return null;
    return buildDiff(previousText.text, latestText.text);
  }, [previous, latestText, previousText]);

  const decide = async (decision: "approve" | "reject") => {
    if (!approval || !latest || busy) return;
    if (decision === "reject" && !comment.trim()) {
      setActionError(t("approvals.decide.commentNeeded"));
      return;
    }
    setBusy(decision);
    setActionError(null);
    try {
      setApproval(await approvalsApi.decide(approval.id, { round: approval.currentRound, decision, comment: comment.trim() }));
      setComment("");
      void refreshApprovalsSummary();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("approvals.actionFailed"));
      void load();
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!approval?.fileKey || !latest) return;
    setBusy("resend");
    setActionError(null);
    try {
      const chain = latest.steps.filter((step) => !step.person.gone).map((step) => step.person.id);
      setApproval(await approvalsApi.send({ project: "none", path: approval.fileKey, approvers: chain }));
      void refreshApprovalsSummary();
      void load();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("approvals.sendFailed"));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    if (!approval || !window.confirm(t("approvals.withdrawConfirm"))) return;
    setBusy("cancel");
    setActionError(null);
    try {
      setApproval(await approvalsApi.cancel(approval.id));
      void refreshApprovalsSummary();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("approvals.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="space-y-3">
        <BackLink />
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (!approval || !latest) return <SkeletonList rows={4} />;

  const proseMode = prefersProse(approval.fileName) ? "text" : "lines";
  const showChanges = view === "changes" && Boolean(previous);
  const returnedOrOutdated = approval.status === "rejected" || approval.status === "outdated";
  const canResend = approval.mine && returnedOrOutdated && Boolean(approval.fileKey) && fileStatus?.current.exists && !fileStatus.current.tooLarge;

  return (
    <div className="space-y-5">
      <BackLink />
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 break-words text-2xl font-semibold">{versionLabel(latest, approval.fileName)}</h2>
          <ApprovalStatusBadge approval={approval} />
        </div>
        <p className="text-sm text-muted-foreground">
          {approval.mine ? t("approvals.fromYou") : t("approvals.from", { name: approval.author.name })}
          {" · "}
          {t("approvals.sentAt", { when: when(latest.createdAt) })}
          {latest.sentByAgent ? ` · ${t("approvals.sentByAgent")}` : ""}
          {approval.currentRound > 1 ? ` · ${t("approvals.roundN", { n: approval.currentRound })}` : ""}
        </p>
        <p className="text-sm">{statusSentence(approval)}</p>
      </header>

      {latest.note ? (
        <section className="rounded-lg border-l-2 border-primary bg-muted/30 px-3 py-2">
          <div className="text-xs text-muted-foreground">{t("approvals.noteFrom", { name: approval.mine ? t("approvals.you") : approval.author.name })}</div>
          <p className="whitespace-pre-wrap break-words text-sm">{latest.note}</p>
        </section>
      ) : null}

      {approval.myTurn ? (
        <section className="space-y-3 rounded-xl border border-warning bg-card p-4" aria-labelledby="approval-decide">
          <h3 id="approval-decide" className="text-sm font-medium">{t("approvals.decide.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("approvals.decide.rule")}</p>
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value.slice(0, APPROVAL_MAX_COMMENT_CHARS))}
            placeholder={t("approvals.decide.commentPlaceholder")}
            aria-label={t("approvals.decide.commentLabel")}
            rows={3}
            className="text-base md:text-sm"
          />
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void decide("approve")} disabled={busy !== null} className="gap-2">
              {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {t("approvals.decide.approve")}
            </Button>
            <Button variant="outline" onClick={() => void decide("reject")} disabled={busy !== null || !comment.trim()} className="gap-2" title={!comment.trim() ? t("approvals.decide.commentNeeded") : undefined}>
              {busy === "reject" ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
              {t("approvals.decide.reject")}
            </Button>
          </div>
        </section>
      ) : null}

      {approval.mine && (returnedOrOutdated || approval.status === "active") ? (
        <section className="space-y-2 rounded-xl border bg-card p-4">
          {returnedOrOutdated ? (
            <p className="text-sm">{fileStatus && !fileStatus.changedSinceSent ? t("approvals.file.unchangedSinceSent") : t("approvals.author.nextStep")}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("approvals.file.activeRule")}</p>
          )}
          {!approval.myTurn && actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          <div className="flex flex-wrap gap-2">
            {approval.fileKey ? (
              <Button variant="outline" size="sm" asChild className="gap-1.5">
                <Link href={filePathOfKey(approval.fileKey)}>
                  <FileText className="size-3.5" />
                  {t("approvals.author.openFile")}
                </Link>
              </Button>
            ) : null}
            {canResend ? (
              <Button size="sm" onClick={() => void resend()} disabled={busy !== null} className="gap-1.5" variant={fileStatus?.changedSinceSent ? "default" : "outline"}>
                {busy === "resend" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                {fileStatus?.changedSinceSent ? t("approvals.file.sendNew") : t("approvals.file.sendSame")}
              </Button>
            ) : null}
            {approval.status === "active" ? (
              <Button size="sm" variant="ghost" onClick={() => void withdraw()} disabled={busy !== null} className="gap-1.5">
                {busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                {t("approvals.withdraw")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="space-y-2" aria-labelledby="approval-chain">
        <h3 id="approval-chain" className="text-sm font-medium">{t("approvals.chain.title")}</h3>
        <ApprovalChain round={latest} />
      </section>

      <section className="space-y-2" aria-labelledby="approval-version">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="approval-version" className="text-sm font-medium">{t("approvals.version.title")}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {previous ? (
              <div role="group" aria-label={t("approvals.version.title")} className="inline-flex rounded-md border p-0.5">
                {(["changes", "text"] as const).map((which) => (
                  <button
                    key={which}
                    type="button"
                    aria-pressed={view === which}
                    onClick={() => setView(which)}
                    className={cn(
                      "rounded px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      view === which ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {which === "changes"
                      ? previous.versionN
                        ? t("approvals.version.changesSinceVersion", { n: previous.versionN })
                        : t("approvals.version.changesSinceRound", { n: previous.round })
                      : t("approvals.version.whole")}
                  </button>
                ))}
              </div>
            ) : null}
            {opensInBrowser(latest.mime) ? (
              <Button variant="ghost" size="sm" asChild className="h-8 gap-1.5">
                <a href={approvalsApi.fileUrl(approval.id, latest.round, true)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  {t("files.open")}
                </a>
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" asChild className="h-8 gap-1.5">
              <a href={approvalsApi.fileUrl(approval.id, latest.round)} download={latest.fileName}>
                <Download className="size-3.5" />
                {t("common.download")}
              </a>
            </Button>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-auto rounded-xl border bg-card py-2">
          {showChanges ? (
            model ? (
              model.changes === 0 ? (
                <p className="px-3 text-sm text-muted-foreground">{t("approvals.version.noChanges")}</p>
              ) : (
                <VersionDiff model={model} mode={proseMode} activeChange={-1} />
              )
            ) : previousText === "error" || latestText === "error" ? (
              <p className="px-3 text-sm text-destructive">{t("approvals.version.failed")}</p>
            ) : latestText && typeof latestText !== "string" && latestText.kind === "none" ? (
              <p className="px-3 text-sm text-muted-foreground">{t("approvals.version.noText")}</p>
            ) : (
              <div className="px-3"><SkeletonList rows={3} /></div>
            )
          ) : latestText === "error" ? (
            <p className="px-3 text-sm text-destructive">{t("approvals.version.failed")}</p>
          ) : !latestText || typeof latestText === "string" ? (
            <div className="px-3"><SkeletonList rows={3} /></div>
          ) : latestText.kind === "none" ? (
            <p className="px-3 text-sm text-muted-foreground">{t("approvals.version.noText")}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words px-3 font-sans text-sm leading-6">{latestText.text}</pre>
          )}
        </div>
        {latestText && typeof latestText !== "string" && latestText.kind === "extracted" ? (
          <p className="text-xs text-muted-foreground">{t("files.history.extractedNote")}</p>
        ) : null}
      </section>

      {approval.rounds.length > 1 ? (
        <section className="space-y-2" aria-labelledby="approval-earlier">
          <h3 id="approval-earlier" className="text-sm font-medium">{t("approvals.earlier.title")}</h3>
          <div className="space-y-2">
            {approval.rounds.slice(1).map((round) => (
              <EarlierRound key={round.round} approvalId={approval.id} round={round} fileName={approval.fileName} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function EarlierRound({ approvalId, round, fileName }: { approvalId: string; round: ApprovalRound; fileName: string }) {
  const { t } = useI18n();
  const { versionLabel } = useApprovalWords();
  const when = useWhen();
  const statusWord =
    round.status === "approved"
      ? round.voidedAt ? t("approvals.status.approvedChanged") : t("approvals.status.approved")
      : round.status === "rejected"
        ? t("approvals.status.rejected")
        : round.status === "outdated"
          ? t("approvals.status.outdated")
          : round.status === "cancelled"
            ? t("approvals.status.cancelled")
            : t("approvals.status.active");
  return (
    <details className="rounded-lg border bg-card px-3 py-2">
      <summary className="cursor-pointer text-sm">
        {t("approvals.roundN", { n: round.round })} · {versionLabel(round, fileName)} · {statusWord} · {when(round.createdAt)}
      </summary>
      <div className="mt-2 space-y-2">
        {round.note ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{round.note}</p> : null}
        <ApprovalChain round={round} />
        <a href={approvalsApi.fileUrl(approvalId, round.round)} download={round.fileName} className="inline-flex items-center gap-1.5 text-xs underline underline-offset-2">
          <Download className="size-3.5" />
          {t("approvals.earlier.download")}
        </a>
      </div>
    </details>
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link href="/dashboard/approvals" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
      {t("approvals.back")}
    </Link>
  );
}
