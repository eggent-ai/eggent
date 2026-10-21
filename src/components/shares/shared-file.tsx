"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2, MousePointerClick, Printer, RefreshCw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/code-editor";
import { HtmlPreview, type PickedBlock } from "@/components/files/html-preview";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import { canComment, canEdit, type ShareFileState, type ShareView } from "@/lib/shares/types";
import { cn } from "@/lib/utils";
import { sharesApi, SharesRequestError, type SharedText } from "./api";
import { ShareComments, type CommentTarget } from "./share-comments";
import { RoleBadge, useRoleWords, useShareWhen } from "./share-parts";
import { refreshSharesSummary } from "./use-shares-summary";

function isHtmlName(name: string): boolean {
  return /\.html?$/i.test(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A file a colleague shared - or one of one's own, as its people see it - with
 * its comments beside it.
 *
 * A page shows as it looks or as its code; text as code; a document as the
 * words read out of it; a picture as itself. A block picked on the page, or
 * lines chosen in the code, is what a new comment is about. Somebody it is
 * shared with to edit changes it here - on the page's words, or in its code -
 * and every change lands only on the version they were looking at.
 */
export function SharedFile({ shareId }: { shareId: string }) {
  const { t } = useI18n();
  const { mayDo } = useRoleWords();
  const when = useShareWhen();
  const [detail, setDetail] = useState<{ share: ShareView; file: ShareFileState } | null>(null);
  const [content, setContent] = useState<SharedText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error"; reload?: boolean } | null>(null);
  const [view, setView] = useState<"page" | "code">("page");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<PickedBlock | null>(null);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [reveal, setReveal] = useState<{ from: number; to: number; key: number } | null>(null);
  const shown = useRef("");

  const load = useCallback(async (options: { keepDraft?: boolean } = {}) => {
    try {
      const [nextDetail, nextContent] = await Promise.all([sharesApi.detail(shareId), sharesApi.text(shareId)]);
      setDetail(nextDetail);
      setContent(nextContent);
      setError(null);
      const text = nextContent.kind === "text" || nextContent.kind === "extracted" ? nextContent.text : "";
      if (!options.keepDraft) setDraft(text);
      shown.current = text;
    } catch (failure) {
      setError(failure instanceof SharesRequestError ? failure.message : t("shares.loadFailed"));
    }
  }, [shareId, t]);

  useEffect(() => {
    setDetail(null);
    setContent(null);
    setPicked(null);
    setTarget(null);
    setNotice(null);
    void load();
    // Opening it is looking at it: what was new is not any more.
    void sharesApi.seen(shareId).then(() => refreshSharesSummary()).catch(() => undefined);
  }, [shareId, load]);

  // A passing word goes after a few seconds; a failure stays until something else happens.
  useEffect(() => {
    if (!notice || notice.tone !== "info") return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const share = detail?.share;
  const role = share?.myRole ?? "view";
  const editable = canEdit(role) && content?.kind === "text";
  const dirty = editable && draft !== shown.current;
  const html = Boolean(share && isHtmlName(share.fileName));

  const save = async () => {
    if (!content || content.kind !== "text" || !dirty || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await sharesApi.save(shareId, { baseSha: content.sha256, text: draft });
      setNotice({ text: t("shares.view.saved"), tone: "info" });
      await load();
    } catch (failure) {
      const code = failure instanceof SharesRequestError ? failure.code : "failed";
      setNotice({
        text: code === "changed" ? t("shares.view.changedSince") : failure instanceof Error ? failure.message : t("shares.view.notSaved"),
        tone: "error",
        reload: code === "changed",
      });
    } finally {
      setSaving(false);
    }
  };

  const pick = useCallback((block: PickedBlock | null) => {
    setPicked(block);
    setTarget(block ? { quote: block.source, anchor: { startLine: block.startLine, endLine: block.endLine, label: block.label } } : null);
  }, []);

  const fromSelection = useCallback((selection: { startLine: number; endLine: number; text: string } | null) => {
    if (selection) setTarget({ quote: selection.text, anchor: { startLine: selection.startLine, endLine: selection.endLine } });
  }, []);

  if (error && !detail) {
    return (
      <div className="space-y-3">
        <BackLink />
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (!share || !content) return <SkeletonList rows={4} />;

  const tab = (which: "page" | "code", label: string) => (
    <button
      type="button"
      aria-pressed={view === which}
      onClick={() => setView(which)}
      className={cn(
        "rounded px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === which ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );

  const linesOf = (block: PickedBlock) =>
    block.startLine === block.endLine ? t("files.page.line", { line: block.startLine }) : t("files.page.lines", { start: block.startLine, end: block.endLine });

  const code = (
    <CodeEditor
      value={draft}
      onChange={editable ? setDraft : () => undefined}
      fileName={content.kind === "extracted" ? "document.txt" : share.fileName}
      readOnly={!editable || saving}
      onSelectionChange={canComment(role) ? fromSelection : undefined}
      onSave={() => void save()}
      ariaLabel={share.fileName}
      reveal={reveal}
      className="flex-1"
    />
  );

  const body =
    content.kind === "image" ? (
      <div className="flex flex-1 items-center justify-center overflow-auto bg-muted/20 p-3">
        <img src={sharesApi.contentUrl(shareId, true)} alt={share.fileName} className="max-h-full max-w-full rounded object-contain" />
      </div>
    ) : content.kind === "binary" ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>{t("shares.view.noPreview")}</p>
        <Button variant="outline" asChild className="gap-2">
          <a href={sharesApi.contentUrl(shareId)} download={share.fileName}>
            <Download className="size-4" />
            {t("common.download")}
          </a>
        </Button>
      </div>
    ) : html && view === "page" ? (
      <HtmlPreview
        source={{ kind: "share", shareId, fileName: share.fileName }}
        version={content.sha256}
        selecting={selecting && !dirty}
        picked={picked !== null}
        onPick={pick}
        onSaved={() => void load()}
        className="flex-1"
      />
    ) : (
      code
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-2">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="break-words text-2xl font-semibold">{share.fileName}</h2>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {share.mine ? t("shares.view.yours", { count: share.people.length }) : t("shares.view.from", { name: share.owner.name })}
              <RoleBadge role={role} />
            </p>
            <p className="text-xs text-muted-foreground">
              {[
                detail.file.modifiedAt ? t("shares.view.changedAt", { when: when(detail.file.modifiedAt) }) : "",
                detail.file.exists ? formatSize(detail.file.size) : "",
                share.mine ? "" : mayDo(share),
              ].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {editable ? (
              <Button onClick={() => void save()} disabled={!dirty || saving} className="gap-2">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t("common.save")}
              </Button>
            ) : null}
            {content.kind === "text" || content.kind === "extracted" ? (
              <Button variant="outline" asChild className="gap-2">
                <a href={sharesApi.printUrl(shareId)} target="_blank" rel="noopener noreferrer">
                  <Printer className="size-4" />
                  {t("files.print")}
                </a>
              </Button>
            ) : null}
            <Button variant="outline" asChild className="gap-2">
              <a href={sharesApi.contentUrl(shareId)} download={share.fileName}>
                <Download className="size-4" />
                {t("common.download")}
              </a>
            </Button>
            <Button variant="ghost" size="icon" className="size-9" onClick={() => void load()} disabled={dirty} aria-label={t("shares.refresh")} title={dirty ? t("shares.view.saveFirst") : t("shares.refresh")}>
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {!detail.file.exists ? <p role="alert" className="border-l-2 border-warning px-3 py-1.5 text-sm">{t("shares.view.gone")}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="relative flex h-[70vh] min-h-[480px] flex-col overflow-hidden rounded-xl border bg-card">
          {html || content.kind === "extracted" ? (
            <div className="flex min-h-10 items-center gap-2 border-b px-2 py-1">
              {html ? (
                <div role="group" aria-label={t("files.page.views")} className="inline-flex shrink-0 rounded-md border p-0.5">
                  {tab("page", t("files.page.page"))}
                  {tab("code", t("files.page.code"))}
                </div>
              ) : null}
              {html && view === "page" && canComment(role) ? (
                <Button
                  type="button"
                  size="sm"
                  variant={selecting ? "secondary" : "ghost"}
                  className="h-7 shrink-0 gap-1.5 text-xs"
                  aria-pressed={selecting}
                  disabled={dirty}
                  title={dirty ? t("files.page.saveFirst") : canEdit(role) ? t("shares.view.selectHelpEdit") : t("shares.view.selectHelp")}
                  onClick={() => setSelecting((value) => !value)}
                >
                  <MousePointerClick className="size-3.5" />
                  {t("files.page.select")}
                </Button>
              ) : null}
              <div role="status" className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                {content.kind === "extracted" ? (
                  <span className="truncate text-muted-foreground">{t("shares.view.extracted")}</span>
                ) : picked && view === "page" ? (
                  <>
                    <span className="min-w-0 truncate" title={`${picked.label} · ${linesOf(picked)}`}>
                      <span className="font-medium">{picked.label}</span>
                      <span className="text-muted-foreground"> · {linesOf(picked)} · {t("shares.view.commentOnIt")}</span>
                    </span>
                    <Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs" onClick={() => { setView("code"); setReveal({ from: picked.start, to: picked.end, key: Date.now() }); }}>
                      {t("files.page.showInCode")}
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="size-6 shrink-0" aria-label={t("files.page.clearPick")} onClick={() => pick(null)}>
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : view === "page" && dirty ? (
                  <span className="truncate text-muted-foreground">{t("files.page.unsavedNotShown")}</span>
                ) : view === "page" && selecting ? (
                  <span className="truncate text-muted-foreground">{canEdit(role) ? t("files.page.selectHint") : t("shares.view.selectHint")}</span>
                ) : null}
              </div>
            </div>
          ) : null}
          {body}
          {notice ? (
            <div role="status" className={cn("absolute inset-x-2 bottom-2 flex flex-wrap items-center gap-2 rounded-md border bg-card/95 px-3 py-1.5 text-xs shadow-sm", notice.tone === "error" ? "border-destructive" : "")}>
              <span className="min-w-0 flex-1">{notice.text}</span>
              {notice.reload ? (
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => { if (window.confirm(t("shares.view.reloadConfirm"))) { setNotice(null); void load(); } }}>
                  {t("shares.view.loadTheirs")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
        <ShareComments
          shareId={shareId}
          canWrite={canComment(role)}
          canTarget={content.kind === "text" || content.kind === "extracted"}
          isOwner={share.mine}
          target={target}
          onClearTarget={() => {
            setTarget(null);
            setPicked(null);
          }}
        />
      </div>
    </div>
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link href="/dashboard/shared" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      <ArrowLeft className="size-3.5" />
      {t("shares.back")}
    </Link>
  );
}
