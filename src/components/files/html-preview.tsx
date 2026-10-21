"use client";

/**
 * A page of this workspace as it looks, in a sandboxed frame - and, with
 * "Select" on, a page to point at: a click picks a block, a double click lets
 * its words be typed over and saved straight into the file.
 *
 * The frame has no origin of its own and is reached only through messages,
 * which are taken from that frame and nobody else. In select mode the page's
 * own scripts are off (the server says so), so what is pointed at is exactly
 * what the file says.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export interface PickedBlock {
  label: string;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
  source: string;
}

type FrameMessage =
  | { type: "ready"; sha: string }
  | { type: "select"; el: number | null; label?: string; text?: string }
  | { type: "edit"; edits: Array<{ el: number; slot: number; was: string; text: string }>; scrollY?: number }
  | { type: "editRefused"; reason: string };

export function HtmlPreview({
  projectId,
  path,
  version,
  selecting,
  onPick,
  onSaved,
  className,
}: {
  projectId: string;
  path: string;
  /** Changes whenever the file was written: the frame is loaded afresh. */
  version: string;
  selecting: boolean;
  onPick?: (block: PickedBlock | null) => void;
  /** Words were written into the file from the page. */
  onSaved?: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [saving, setSaving] = useState(false);
  const sha = useRef<string | null>(null);
  const keepScroll = useRef<number | null>(null);
  const callbacks = useRef({ onPick, onSaved });
  callbacks.current = { onPick, onSaved };

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ project: projectId, path, ...(selecting ? { mode: "edit" } : {}) });
      const response = await fetch(`/api/files/page-link?${params.toString()}`, { cache: "no-store" });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error || "failed");
      sha.current = null;
      setUrl(data.url);
    } catch {
      setUrl(null);
      setNotice({ text: t("files.page.loadFailed"), tone: "error" });
    }
  }, [projectId, path, selecting, t]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    if (!selecting) callbacks.current.onPick?.(null);
    setNotice(null);
  }, [selecting]);

  // A passing word goes after a few seconds; a failure stays until something else happens.
  useEffect(() => {
    if (!notice || notice.tone !== "info") return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ eggent: 1, ...message }, "*");
  }, []);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as (FrameMessage & { eggent?: number }) | null;
      if (!data || data.eggent !== 1) return;
      if (data.type === "ready") {
        sha.current = data.sha;
        if (keepScroll.current !== null) {
          post({ type: "scroll", y: keepScroll.current });
          keepScroll.current = null;
        }
        return;
      }
      if (data.type === "select") {
        if (data.el === null || !sha.current) {
          callbacks.current.onPick?.(null);
          return;
        }
        const params = new URLSearchParams({ project: projectId, path, sha: sha.current, el: String(data.el) });
        const response = await fetch(`/api/files/page-element?${params.toString()}`, { cache: "no-store" });
        if (response.status === 409) {
          setNotice({ text: t("files.page.changedReloaded"), tone: "info" });
          void load();
          return;
        }
        if (!response.ok) return;
        callbacks.current.onPick?.((await response.json()) as PickedBlock);
        return;
      }
      if (data.type === "editRefused") {
        setNotice({ text: t(data.reason === "structure" ? "files.page.onlyText" : data.reason === "noText" ? "files.page.noText" : "files.page.cannotEdit"), tone: "info" });
        return;
      }
      if (data.type === "edit" && sha.current) {
        setSaving(true);
        setNotice(null);
        keepScroll.current = typeof data.scrollY === "number" ? data.scrollY : null;
        try {
          const response = await fetch("/api/files/page-edit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: projectId, path, sha: sha.current, edits: data.edits }),
          });
          if (response.ok) {
            setNotice({ text: t("files.page.saved"), tone: "info" });
            callbacks.current.onSaved?.();
          } else {
            const failure = (await response.json().catch(() => null)) as { code?: string } | null;
            setNotice({ text: failure?.code === "changed" ? t("files.page.changedReloaded") : t("files.page.notWritten"), tone: "error" });
            void load();
          }
        } finally {
          setSaving(false);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [projectId, path, load, post, t]);

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      {url ? (
        <iframe
          ref={frame}
          key={url}
          src={url}
          title={path.split("/").pop() || path}
          sandbox={selecting ? "allow-scripts" : "allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {notice?.tone === "error" ? null : <Loader2 className="size-4 animate-spin" />}
        </div>
      )}
      {/* Over the page, not above it: a line that appeared above would move the page under the pointer. */}
      {notice || saving ? (
        <div
          role="status"
          className={cn(
            "pointer-events-none absolute inset-x-2 bottom-2 rounded-md border bg-card/95 px-3 py-1.5 text-xs shadow-sm",
            notice?.tone === "error" ? "border-destructive text-foreground" : "text-foreground"
          )}
        >
          {saving ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />{t("files.page.saving")}</span>
          ) : notice?.text}
        </div>
      ) : null}
    </div>
  );
}
