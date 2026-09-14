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

import { useEffect } from "react";
import { FolderOpen, X } from "lucide-react";
import { FileTree } from "@/components/file-tree";
import { Button } from "@/components/ui/button";
import { useAppStore, readFilesPanelPreference } from "@/store/app-store";
import { useI18n } from "@/i18n/provider";

export function FilesPanel() {
  const { t } = useI18n();
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const open = useAppStore((state) => state.filesPanelOpen);
  const setOpen = useAppStore((state) => state.setFilesPanelOpen);

  // After mount, not as the store's initial value: the server renders this too.
  useEffect(() => {
    if (readFilesPanelPreference()) setOpen(true);
  }, [setOpen]);

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
        // Width rather than display: a panel that is removed from the tree
        // cannot animate, and the tree inside would refetch on every open.
        className={[
          // Its own height, not the row's. On the chat screen the row is
          // exactly the viewport, but the file view scrolls with its content,
          // and there the panel ended wherever the text happened to stop.
          // Sticky so it stays put while that content scrolls past it.
          "sticky top-0 h-[calc(100svh-var(--header-height,3.5rem))] shrink-0 overflow-hidden border-l bg-sidebar",
          "transition-[width,transform] duration-200 ease-out motion-reduce:transition-none",
          "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:h-auto max-md:w-80",
          "max-md:data-[state=closed]:translate-x-full max-md:data-[state=open]:translate-x-0",
          "md:data-[state=closed]:w-0 md:data-[state=open]:w-80",
        ].join(" ")}
        aria-hidden={!open}
      >
      <div className="flex h-full w-80 flex-col">
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
      </aside>
    </>
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
