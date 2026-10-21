"use client";

/**
 * The workspace files, in a panel of their own on the right.
 *
 * They used to sit in the left sidebar, under the project list and above the
 * chat history, where three things competed for one column of height: the tree
 * pushed the chat list down, and a deep folder pushed it off the screen. Files
 * and conversations are also looked at in different moments - you open the tree
 * to find something, then close it and go back to talking - so it behaves like
 * a panel you summon rather than furniture you live with.
 *
 * Closed it takes no width at all rather than collapsing to a rail: there is
 * nothing useful to show in a strip that narrow, and the chat is what the space
 * belongs to.
 */

import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ClipboardCheck, Download, ExternalLink, FolderOpen, History, Loader2, Maximize2, Printer, Save, Users, X } from "lucide-react";
import { FileTree } from "@/components/file-tree";
import { FileBody, formatFileSize, useFileContent } from "@/components/file-view";
import { VersionHistory } from "@/components/files/version-history";
import { FileApproval, FileApprovalNotice, useFileApproval } from "@/components/approvals/file-approval";
import { useApprovalsSummary } from "@/components/approvals/use-approvals-summary";
import { FileShare, FileShareNotice, useFileShare } from "@/components/shares/file-share";
import { useSharesSummary } from "@/components/shares/use-shares-summary";
import { Button } from "@/components/ui/button";
import {
  clampFilePreviewWidth,
  readFilePreviewWidth,
  readFilesPanelPreference,
  useAppStore,
} from "@/store/app-store";
import { useI18n } from "@/i18n/provider";
import { fileDownloadUrl, filePrintUrl, filesPageUrl, isModifiedClick, isOpenableFile } from "@/lib/files/openable";

const KEYBOARD_STEP_PX = 32;

export function FilesPanel() {
  const { t } = useI18n();
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const open = useAppStore((state) => state.filesPanelOpen);
  const setOpen = useAppStore((state) => state.setFilesPanelOpen);
  const preview = useAppStore((state) => state.filePreview);
  const closePreview = useAppStore((state) => state.closeFilePreview);
  const width = useAppStore((state) => state.filePreviewWidth);
  const setWidth = useAppStore((state) => state.setFilePreviewWidth);
  const terminalOpen = useAppStore((state) => state.terminalPanelOpen);
  const terminalWidth = useAppStore((state) => state.terminalPanelWidth);
  const [resizing, setResizing] = useState(false);
  const previewing = open && preview !== null;

  // After mount, not as the store's initial value: the server renders this too.
  useEffect(() => {
    if (readFilesPanelPreference()) setOpen(true);
    setWidth(readFilePreviewWidth(), false);
  }, [setOpen, setWidth]);

  const startResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      setResizing(true);
      // A drag across the chat would otherwise select its text as it goes.
      const previousSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      const move = (moved: globalThis.PointerEvent) => setWidth(startWidth + (startX - moved.clientX), false);
      const finish = () => {
        window.removeEventListener("pointermove", move);
        document.body.style.userSelect = previousSelect;
        setResizing(false);
        setWidth(useAppStore.getState().filePreviewWidth, true);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish, { once: true });
      window.addEventListener("pointercancel", finish, { once: true });
    },
    [setWidth, width]
  );

  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX;
    setWidth(clampFilePreviewWidth(width + delta), true);
  };

  return (
    <>
      {/* On a phone there is no room for a third column, so the panel comes
          over the conversation instead. Hiding it below `md` was the first
          cut and it took the file tree away from phones entirely, which is
          worse than the crowding it avoided. */}
      {open ? (
        <button
          type="button"
          aria-label={t("files.panel.close")}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      ) : null}
      <aside
        data-state={open ? "open" : "closed"}
        data-preview={previewing ? "true" : "false"}
        data-resizing={resizing ? "true" : "false"}
        style={{
          // One variable for the open width: two width rules, one per state,
          // resolved by stylesheet order, and the narrow one won.
          ["--files-width" as string]: previewing ? `${width}px` : "20rem",
          // A file being read wants room, but never the conversation's: the
          // chat keeps 24rem, and an open terminal keeps its own.
          ["--files-max" as string]: `calc(100vw - var(--sidebar-width, 16rem) - 24rem${terminalOpen ? ` - ${terminalWidth}px` : ""})`,
        }}
        // Width rather than display: a panel that is removed from the tree
        // cannot animate, and the tree inside would refetch on every open.
        className={[
          // Its own height, not the row's. On the chat screen the row is
          // exactly the viewport, but the file view scrolls with its content,
          // and there the panel ended wherever the text happened to stop.
          // Sticky so it stays put while that content scrolls past it - and
          // under the header, which is sticky too: stuck at the top instead,
          // the panel slid beneath it and hid its own title and close button.
          "sticky top-[var(--header-height,3.5rem)] h-[calc(100svh-var(--header-height,3.5rem))] shrink-0 overflow-hidden border-l bg-sidebar",
          "transition-[width,transform] duration-200 ease-out motion-reduce:transition-none data-[resizing=true]:transition-none",
          "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:h-auto max-md:w-80 max-md:data-[preview=true]:w-[min(100vw,36rem)]",
          "max-md:data-[state=closed]:translate-x-full max-md:data-[state=open]:translate-x-0",
          "md:data-[state=closed]:w-0 md:data-[state=open]:w-(--files-width)",
          "md:data-[preview=true]:max-w-(--files-max) md:data-[preview=true]:min-w-80",
        ].join(" ")}
        aria-hidden={!open}
        inert={!open}
      >
      <div className="relative flex h-full w-80 flex-col data-[preview=true]:w-full" data-preview={previewing ? "true" : "false"}>
        {previewing ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("files.panel.resize")}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={resizeWithKeys}
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none md:block"
          />
        ) : null}
        {previewing && preview ? (
          <FilePreview
            key={`${preview.projectId}|${preview.path}`}
            projectId={preview.projectId}
            path={preview.path}
            onBack={closePreview}
            onClose={() => setOpen(false)}
          />
        ) : null}
        {/* The tree stays mounted under a preview: going back finds it as it
            was, scrolled and expanded, without asking the server again. */}
        <div className={previewing ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <FolderOpen className="size-4" />
              {t("nav.files")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
              aria-label={t("files.panel.close")}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <FileTree projectId={activeProjectId ?? "none"} />
          </div>
        </div>
      </div>
      </aside>
    </>
  );
}

const panelIconButton = "size-7 text-muted-foreground hover:text-foreground";

/** One file, read and edited inside the panel; the full page is a click away. */
function FilePreview({ projectId, path, onBack, onClose }: {
  projectId: string;
  path: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const file = useFileContent(projectId, path);
  const { metadata, dirty, saving, status, error, title } = file;
  const openable = isOpenableFile(path);
  // The file, or its history or its approval in its place.
  const [showHistory, setShowHistory] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const approvalsOn = Boolean(useApprovalsSummary()?.enabled);
  const sharesOn = Boolean(useSharesSummary()?.enabled);
  // Asked again after every save, so the line about what a change does stays true.
  const savedAt = metadata?.updatedAt ? Date.parse(metadata.updatedAt) || 0 : 0;
  const fileApproval = useFileApproval(projectId, path, approvalsOn && !showApproval, savedAt);
  const fileShare = useFileShare(projectId, path, sharesOn && !showShare, savedAt);
  const paneOpen = showHistory || showApproval || showShare;
  const setSelection = useAppStore((state) => state.setFilePreviewSelection);
  const setUnsaved = useAppStore((state) => state.setFilePreviewUnsaved);

  // The chat beside this panel tells the agent about unsaved edits (openFileForAgent).
  useEffect(() => {
    setUnsaved(dirty);
  }, [dirty, setUnsaved]);

  // Unsaved text is not dropped without asking - the panel is easy to leave.
  const leave = (then: () => void) => {
    if (dirty && !window.confirm(t("files.panel.discardChanges"))) return;
    then();
  };

  const saveWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (dirty && !saving) void file.save();
    }
  };

  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const facts = [folder, formatFileSize(metadata?.size)].filter(Boolean).join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={saveWithKeys}>
      <div className="flex items-center gap-1 border-b px-2 py-2">
        <Button
          variant="ghost"
          size="icon"
          className={panelIconButton}
          onClick={() => leave(onBack)}
          aria-label={t("files.panel.back")}
          title={t("files.panel.back")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium" title={path}>{title}</div>
          {facts ? <div className="truncate text-xs text-muted-foreground" title={path}>{facts}</div> : null}
        </div>
        <span className="flex shrink-0 items-center gap-0.5">
          {!file.isMedia && !file.loading && metadata && !paneOpen ? (
            <Button
              variant={dirty ? "default" : "ghost"}
              size="icon"
              className={dirty ? "size-7" : panelIconButton}
              onClick={() => void file.save()}
              disabled={!dirty || saving}
              aria-label={t("common.save")}
              title={`${t("common.save")} (⌘S)`}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            </Button>
          ) : null}
          {!file.isMedia ? (
            <Button
              variant="ghost"
              size="icon"
              className={showHistory ? "size-7 bg-accent text-accent-foreground" : panelIconButton}
              onClick={() => {
                setShowHistory((value) => !value);
                setShowApproval(false);
                setShowShare(false);
              }}
              aria-pressed={showHistory}
              aria-label={t("files.history.toggle")}
              title={t("files.history.toggle")}
            >
              <History className="size-4" />
            </Button>
          ) : null}
          {approvalsOn ? (
            <Button
              variant="ghost"
              size="icon"
              className={showApproval ? "size-7 bg-accent text-accent-foreground" : panelIconButton}
              onClick={() => {
                if (!showApproval && dirty && !window.confirm(t("files.panel.discardChanges"))) return;
                setShowApproval((value) => !value);
                setShowHistory(false);
                setShowShare(false);
              }}
              aria-pressed={showApproval}
              aria-label={t("approvals.file.toggle")}
              title={t("approvals.file.toggle")}
            >
              <ClipboardCheck className="size-4" />
            </Button>
          ) : null}
          {sharesOn ? (
            <Button
              variant="ghost"
              size="icon"
              className={showShare ? "size-7 bg-accent text-accent-foreground" : panelIconButton}
              onClick={() => {
                if (!showShare && dirty && !window.confirm(t("files.panel.discardChanges"))) return;
                setShowShare((value) => !value);
                setShowHistory(false);
                setShowApproval(false);
              }}
              aria-pressed={showShare}
              aria-label={t("shares.file.toggle")}
              title={t("shares.file.toggle")}
            >
              <Users className="size-4" />
            </Button>
          ) : null}
          {openable ? (
            <Button variant="ghost" size="icon" className={panelIconButton} asChild>
              <a
                href={fileDownloadUrl(projectId, path, { inline: true })}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("files.open")}
                title={t("files.open")}
              >
                <ExternalLink className="size-4" />
              </a>
            </Button>
          ) : null}
          {!file.isMedia && metadata ? (
            <Button variant="ghost" size="icon" className={panelIconButton} asChild>
              <a href={filePrintUrl(projectId, path)} target="_blank" rel="noopener noreferrer" aria-label={t("files.print")} title={t("files.print")}>
                <Printer className="size-4" />
              </a>
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" className={panelIconButton} asChild>
            <a href={fileDownloadUrl(projectId, path)} download={title} aria-label={t("common.download")} title={t("common.download")}>
              <Download className="size-4" />
            </a>
          </Button>
          <Button variant="ghost" size="icon" className={panelIconButton} asChild>
            <Link
              href={filesPageUrl(projectId, path)}
              onClick={(event) => {
                if (isModifiedClick(event)) return;
                if (dirty && !window.confirm(t("files.panel.discardChanges"))) {
                  event.preventDefault();
                  return;
                }
                // The full page shows it; the panel beside it would show it twice.
                onBack();
              }}
              aria-label={t("files.panel.fullPage")}
              title={t("files.panel.fullPage")}
            >
              <Maximize2 className="size-4" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={panelIconButton}
            onClick={() => leave(onClose)}
            aria-label={t("files.panel.close")}
            title={t("files.panel.close")}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>
      {status || (error && metadata) ? (
        <div role="status" className={["border-b px-3 py-1.5 text-xs", error ? "text-destructive" : "text-muted-foreground"].join(" ")}>
          {error && metadata ? error : status}
        </div>
      ) : null}
      {!paneOpen ? <FileApprovalNotice status={fileApproval.status} className="border-b" /> : null}
      {!paneOpen ? <FileShareNotice status={fileShare.status} className="border-b" /> : null}
      {showHistory ? (
        <div className="min-h-0 flex-1">
          <VersionHistory projectId={projectId} path={path} fill onRestored={() => void file.refresh()} />
        </div>
      ) : showApproval ? (
        <div className="min-h-0 flex-1">
          <FileApproval projectId={projectId} path={path} fill version={savedAt} />
        </div>
      ) : showShare ? (
        <div className="min-h-0 flex-1">
          <FileShare projectId={projectId} path={path} fill version={savedAt} />
        </div>
      ) : (
        <div className={file.isMedia || file.loading || !metadata ? "min-h-0 flex-1 overflow-auto p-2" : "min-h-0 flex-1"}>
          <FileBody file={file} fill onSelectionChange={setSelection} />
        </div>
      )}
    </div>
  );
}

/** The button that opens it, in the header's right corner. */
export function FilesPanelTrigger() {
  const { t } = useI18n();
  const open = useAppStore((state) => state.filesPanelOpen);
  const toggle = useAppStore((state) => state.toggleFilesPanel);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={toggle}
      aria-label={t("files.panel.toggle")}
      aria-pressed={open}
      title={t("files.panel.toggle")}
    >
      <FolderOpen className="size-4" />
    </Button>
  );
}
