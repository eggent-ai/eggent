"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CornerDownRight, Loader2, MessageSquare, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { SHARE_MAX_COMMENT_CHARS, type ShareComment, type ShareCommentAnchor } from "@/lib/shares/types";
import { cn } from "@/lib/utils";
import { sharesApi } from "./api";
import { useShareWhen } from "./share-parts";
import { refreshSharesSummary } from "./use-shares-summary";

/** A piece of the file a new comment is about: a block picked on the page, lines chosen in the code. */
export interface CommentTarget {
  quote: string;
  anchor: ShareCommentAnchor;
}

const POLL_MS = 30_000;

/**
 * The comments on a shared file, in threads, and the box to write one.
 *
 * A thread may be about a piece of the file - the quote it was written on
 * stays with it, as the piece read then. Its author or the file's owner
 * resolves it or deletes it; resolved threads fold away under a line of
 * their own. Read again every half minute while it is on screen.
 */
export function ShareComments({
  shareId,
  canWrite,
  canTarget = false,
  isOwner,
  target,
  onClearTarget,
  className,
}: {
  shareId: string;
  canWrite: boolean;
  /** The file beside it can be pointed at - a block on the page, lines in the code - so the hint says how. */
  canTarget?: boolean;
  isOwner: boolean;
  target?: CommentTarget | null;
  onClearTarget?: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const when = useShareWhen();
  const [comments, setComments] = useState<ShareComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    try {
      setComments(await sharesApi.comments(shareId));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("shares.comments.loadFailed"));
    }
  }, [shareId, t]);

  useEffect(() => {
    setComments(null);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const threads = useMemo(() => {
    const top = (comments ?? []).filter((comment) => !comment.replyTo);
    return top.map((thread) => ({ thread, replies: (comments ?? []).filter((comment) => comment.replyTo === thread.id) }));
  }, [comments]);
  const open = threads.filter((entry) => !entry.thread.resolved);
  const resolved = threads.filter((entry) => entry.thread.resolved);

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await load();
      void refreshSharesSummary();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("shares.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const post = () => {
    const body = draft.trim();
    if (!body) return;
    void act("post", async () => {
      await sharesApi.comment(shareId, { body, quote: target?.quote ?? null, anchor: target?.anchor ?? null });
      setDraft("");
      onClearTarget?.();
    });
  };

  const answer = (threadId: string) => {
    const body = reply.trim();
    if (!body) return;
    void act(`reply:${threadId}`, async () => {
      await sharesApi.comment(shareId, { body, replyTo: threadId });
      setReply("");
      setReplyTo(null);
    });
  };

  const anchorLine = (anchor: ShareCommentAnchor | null) => {
    if (!anchor) return "";
    const lines = anchor.startLine
      ? anchor.endLine && anchor.endLine !== anchor.startLine
        ? t("files.page.lines", { start: anchor.startLine, end: anchor.endLine })
        : t("files.page.line", { line: anchor.startLine })
      : "";
    return [anchor.label, lines].filter(Boolean).join(" · ");
  };

  const mayManage = (comment: ShareComment) => isOwner || comment.mine;

  const one = (comment: ShareComment, isReply: boolean) => (
    <div className={cn("space-y-1", isReply && "border-l-2 pl-3")}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-foreground">{comment.mine ? t("shares.comments.you") : comment.author.name}</span>
        {comment.author.gone ? <span className="text-muted-foreground">{t("shares.person.gone")}</span> : null}
        {comment.viaAgent ? <span className="text-muted-foreground">{t("shares.comments.viaAgent")}</span> : null}
        <span className="text-muted-foreground">{when(comment.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{comment.body}</p>
      {mayManage(comment) && isReply ? (
        <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" disabled={busy !== null}
          onClick={() => { if (window.confirm(t("shares.comments.deleteConfirm"))) void act(`delete:${comment.id}`, () => sharesApi.remove(shareId, comment.id)); }}>
          <Trash2 className="size-3" />
          {t("shares.comments.delete")}
        </Button>
      ) : null}
    </div>
  );

  const thread = ({ thread: head, replies }: { thread: ShareComment; replies: ShareComment[] }) => (
    <li key={head.id} className={cn("space-y-2 rounded-lg border bg-card p-3", head.resolved && "opacity-80")}>
      {head.quote ? (
        <div className="space-y-0.5">
          {head.anchor ? <div className="text-xs text-muted-foreground">{anchorLine(head.anchor)}</div> : null}
          <blockquote className="line-clamp-4 whitespace-pre-wrap break-words border-l-2 border-info pl-2 font-mono text-xs text-muted-foreground">{head.quote}</blockquote>
        </div>
      ) : null}
      {one(head, false)}
      {replies.length ? <div className="space-y-2">{replies.map((entry) => <div key={entry.id}>{one(entry, true)}</div>)}</div> : null}
      {head.resolved ? <p className="text-xs text-muted-foreground">{t("shares.comments.resolvedBy", { name: head.resolved.by || "—" })}</p> : null}
      {replyTo === head.id ? (
        <div className="space-y-1.5">
          <Textarea value={reply} onChange={(event) => setReply(event.target.value.slice(0, SHARE_MAX_COMMENT_CHARS))} rows={2} className="min-h-14 text-base md:text-sm" placeholder={t("shares.comments.replyPlaceholder")} autoFocus
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") answer(head.id); }} />
          <div className="flex gap-1.5">
            <Button type="button" size="sm" className="h-7 text-xs" disabled={!reply.trim() || busy !== null} onClick={() => answer(head.id)}>
              {busy === `reply:${head.id}` ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("shares.comments.reply")}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setReplyTo(null); setReply(""); }}>{t("common.cancel")}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {canWrite && !head.resolved ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => { setReplyTo(head.id); setReply(""); }}>
              <CornerDownRight className="size-3.5" />
              {t("shares.comments.reply")}
            </Button>
          ) : null}
          {mayManage(head) ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={busy !== null}
              onClick={() => void act(`resolve:${head.id}`, () => sharesApi.resolve(shareId, head.id, !head.resolved))}>
              {head.resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
              {head.resolved ? t("shares.comments.reopen") : t("shares.comments.resolve")}
            </Button>
          ) : null}
          {mayManage(head) ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-muted-foreground" disabled={busy !== null}
              onClick={() => { if (window.confirm(t("shares.comments.deleteThreadConfirm"))) void act(`delete:${head.id}`, () => sharesApi.remove(shareId, head.id)); }}>
              <Trash2 className="size-3.5" />
              {t("shares.comments.delete")}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );

  return (
    <section className={cn("space-y-3", className)} aria-label={t("shares.comments.title")}>
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <MessageSquare aria-hidden className="size-4 text-muted-foreground" />
        {t("shares.comments.title")}
        {open.length ? <span className="text-xs font-normal text-muted-foreground">{open.length}</span> : null}
      </h3>
      {canWrite ? (
        <div className="space-y-1.5">
          {target ? (
            <div className="flex items-start gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="text-muted-foreground">{t("shares.comments.about", { what: anchorLine(target.anchor) || t("shares.comments.thePiece") })}</div>
                <div className="line-clamp-2 break-words font-mono text-[11px]/4 text-muted-foreground">{target.quote}</div>
              </div>
              {onClearTarget ? (
                <Button type="button" size="icon" variant="ghost" className="size-6 shrink-0" aria-label={t("shares.comments.clearTarget")} onClick={onClearTarget}>
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, SHARE_MAX_COMMENT_CHARS))}
            rows={2}
            className="min-h-16 text-base md:text-sm"
            placeholder={target ? t("shares.comments.placeholderOnPiece") : t("shares.comments.placeholder")}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") post(); }}
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="gap-1.5" disabled={!draft.trim() || busy !== null} onClick={post}>
              {busy === "post" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("shares.comments.post")}
            </Button>
            {!target && canTarget ? <span className="text-xs text-muted-foreground">{t("shares.comments.pickHint")}</span> : null}
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {comments === null ? (
        <SkeletonList rows={2} />
      ) : threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("shares.comments.none")}</p>
      ) : (
        <>
          {open.length ? <ul className="space-y-2">{open.map(thread)}</ul> : <p className="text-sm text-muted-foreground">{t("shares.comments.allResolved")}</p>}
          {resolved.length ? (
            <div className="space-y-2">
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={showResolved} onClick={() => setShowResolved((value) => !value)}>
                {t(showResolved ? "shares.comments.hideResolved" : "shares.comments.showResolved", { count: resolved.length })}
              </Button>
              {showResolved ? <ul className="space-y-2">{resolved.map(thread)}</ul> : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
