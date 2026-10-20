"use client";

/**
 * One file, loaded, shown and saved - for the full-page editor and for the
 * preview inside the files panel, which must never disagree about what a file
 * holds or how it is written back.
 */

import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { subscribeUiSync } from "@/hooks/use-background-sync";
import { useI18n } from "@/i18n/provider";
import { historyKeyOf } from "@/lib/files/versions/rules";
import { cn } from "@/lib/utils";

export type FilePayload = {
  projectId: string;
  path: string;
  filename: string;
  content: string;
  contentType?: string;
  previewUrl?: string;
  binary?: boolean;
  size?: number;
  updatedAt?: string;
};

export function formatFileSize(bytes?: number) {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function useFileContent(projectId: string, filePath: string) {
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [metadata, setMetadata] = useState<FilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A newer text written while this one had unsaved edits: offered, never put over them.
  const [external, setExternal] = useState<FilePayload | null>(null);
  const latest = useRef({ content: "", draft: "" });
  latest.current = { content, draft };

  /**
   * Read the file again after something else wrote it - the agent, a restore,
   * the sync. Unedited text is replaced quietly; text with edits in it is left
   * alone and the newer one is offered beside it.
   */
  const refresh = useCallback(async () => {
    if (!filePath) return;
    try {
      const params = new URLSearchParams({ project: projectId, path: filePath });
      const res = await fetch(`/api/files/content?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const payload = (await res.json()) as FilePayload;
      const { content: shown, draft: typed } = latest.current;
      setMetadata(payload);
      if ((payload.content || "") === shown) return;
      if (typed === shown) {
        setContent(payload.content || "");
        setDraft(payload.content || "");
        setStatus(t("files.updatedElsewhere"));
      } else {
        setExternal(payload);
      }
    } catch {
      // The next change will try again.
    }
  }, [projectId, filePath, t]);

  const takeExternal = useCallback(() => {
    if (!external) return;
    setContent(external.content || "");
    setDraft(external.content || "");
    setMetadata(external);
    setExternal(null);
    setStatus(t("files.updatedElsewhere"));
  }, [external, t]);

  // Saving now writes over the newer text; that text stays in the file's history.
  const keepMine = useCallback(() => {
    if (!external) return;
    setContent(external.content || "");
    setExternal(null);
  }, [external]);

  useEffect(() => {
    const key = historyKeyOf(projectId, filePath);
    return subscribeUiSync((event) => {
      if (event.reason === "file_version" && event.paths?.includes(key)) void refresh();
    });
  }, [projectId, filePath, refresh]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!filePath) {
        setError(t("files.noFileSelected"));
        setLoading(false);
        return;
      }
      setLoading(true);
      setStatus(null);
      setError(null);
      setMetadata(null);
      setExternal(null);
      try {
        const params = new URLSearchParams({ project: projectId, path: filePath });
        const res = await fetch(`/api/files/content?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t("files.loadFailed"));
        if (cancelled) return;
        const payload = json as FilePayload;
        setMetadata(payload);
        setContent(payload.content || "");
        setDraft(payload.content || "");
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("files.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // `t` changes identity with the language only; reloading for it is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, filePath]);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const params = new URLSearchParams({ project: projectId, path: filePath });
      const res = await fetch(`/api/files/content?${params.toString()}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("files.saveFailed"));
      const payload = json as FilePayload;
      setMetadata(payload);
      setContent(payload.content || draft);
      setDraft(payload.content || draft);
      setExternal(null);
      setStatus(t("files.saved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("files.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, draft, t]);

  const isImage = Boolean(metadata?.previewUrl && metadata.contentType?.startsWith("image/"));
  const isAudio = Boolean(metadata?.previewUrl && metadata.contentType?.startsWith("audio/"));

  return {
    metadata,
    draft,
    setDraft,
    loading,
    saving,
    status,
    error,
    save,
    refresh,
    external: external !== null,
    takeExternal,
    keepMine,
    dirty: draft !== content,
    isImage,
    isAudio,
    isMedia: isImage || isAudio,
    title: metadata?.filename || filePath.split("/").pop() || t("files.defaultTitle"),
  };
}

export type FileContentState = ReturnType<typeof useFileContent>;

/**
 * What the file holds: a picture, a player, or its text to edit. `fill` makes
 * the text take the height it is given instead of a fixed page-sized box.
 */
/** The lines a selection in the text covers, and its text, or null for no selection. */
export function selectionOf(value: string, start: number, end: number): { startLine: number; endLine: number; text: string } | null {
  if (end <= start) return null;
  const text = value.slice(start, end);
  if (!text.trim()) return null;
  const startLine = value.slice(0, start).split("\n").length;
  // A selection that ends at the start of a line does not take that line.
  const endLine = startLine + text.replace(/\n$/, "").split("\n").length - 1;
  return { startLine, endLine, text: text.slice(0, 4000) };
}

export function FileBody({ file, fill = false, onSelectionChange }: {
  file: FileContentState;
  fill?: boolean;
  /** Told what the person has selected in the text, so the chat beside it can tell the agent. */
  onSelectionChange?: (selection: { startLine: number; endLine: number; text: string } | null) => void;
}) {
  const { t } = useI18n();
  const { metadata } = file;
  const reportSelection = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    if (!onSelectionChange) return;
    const area = event.currentTarget;
    onSelectionChange(selectionOf(area.value, area.selectionStart, area.selectionEnd));
  };

  if (file.loading) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t("common.loadingFile")}
      </div>
    );
  }
  if (file.error && !metadata) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{file.error}</AlertDescription>
      </Alert>
    );
  }
  if (file.isImage && metadata?.previewUrl) {
    return (
      <div className="overflow-hidden rounded-lg border bg-muted/20 p-3">
        <img
          src={metadata.previewUrl}
          alt={file.title}
          className={cn("mx-auto max-w-full rounded object-contain", fill ? "max-h-full" : "max-h-[70vh]")}
        />
      </div>
    );
  }
  if (file.isAudio && metadata?.previewUrl) {
    // The browser's own player: seeking, volume and speed come with it.
    return (
      <div className="rounded-lg border bg-muted/20 p-3">
        <audio
          controls
          preload="metadata"
          src={metadata.previewUrl}
          aria-label={file.title}
          className="w-full dark:scheme-dark"
        />
      </div>
    );
  }
  return (
    <div className={cn("flex min-h-0 flex-col", fill && "h-full")}>
      {file.external ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-l-2 border-l-warning bg-muted/50 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">{t("files.changedWhileEditing")}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={file.takeExternal}>{t("files.takeTheirs")}</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={file.keepMine}>{t("files.keepMine")}</Button>
        </div>
      ) : null}
    <Textarea
      value={file.draft}
      onChange={(event) => file.setDraft(event.target.value)}
      onSelect={reportSelection}
      disabled={file.saving}
      rows={fill ? undefined : 24}
      spellCheck={false}
      aria-label={file.title}
      className={cn(
        "font-mono text-sm",
        fill ? "h-full min-h-0 flex-1 resize-none rounded-none border-0 shadow-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" : "min-h-[560px]"
      )}
    />
    </div>
  );
}
