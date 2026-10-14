"use client";

/**
 * One file, loaded, shown and saved - for the full-page editor and for the
 * preview inside the files panel, which must never disagree about what a file
 * holds or how it is written back.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
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
export function FileBody({ file, fill = false }: { file: FileContentState; fill?: boolean }) {
  const { t } = useI18n();
  const { metadata } = file;

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
    <Textarea
      value={file.draft}
      onChange={(event) => file.setDraft(event.target.value)}
      disabled={file.saving}
      rows={fill ? undefined : 24}
      spellCheck={false}
      aria-label={file.title}
      className={cn(
        "font-mono text-sm",
        fill ? "h-full min-h-0 resize-none rounded-none border-0 shadow-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" : "min-h-[560px]"
      )}
    />
  );
}
