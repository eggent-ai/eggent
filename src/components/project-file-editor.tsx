"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";

interface ProjectFileEditorProps {
  /** A project id, or the orchestrator's scope id. */
  projectId: string;
  endpoint: "context" | "memory";
  filename: string;
  description?: string;
  rows?: number;
}

export function ProjectFileEditor({
  projectId,
  endpoint,
  filename,
  description,
  rows = 18,
}: ProjectFileEditorProps) {
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/projects/${encodeURIComponent(projectId)}/${endpoint}`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setStatus(null);
        setError(null);
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t("projectEditor.loadFailed", { filename }));
        if (cancelled) return;
        const next = typeof json.content === "string" ? json.content : "";
        setContent(next);
        setDraft(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("projectEditor.loadFailed", { filename }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, filename]);

  async function save() {
    try {
      setSaving(true);
      setStatus(null);
      setError(null);
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("projectEditor.saveFailed", { filename }));
      const next = typeof json.content === "string" ? json.content : draft;
      setContent(next);
      setDraft(next);
      setStatus(t("projectEditor.saved", { filename }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("projectEditor.saveFailed", { filename }));
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft !== content;

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-sm text-muted-foreground">{filename}</div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <Button onClick={save} disabled={saving || loading || !dirty} className="gap-2">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {t("common.save")}
        </Button>
      </div>

      {status ? <Badge variant="secondary">{status}</Badge> : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("projectEditor.loading", { filename })}
        </div>
      ) : (
        <Textarea
          aria-label={filename}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={rows}
          disabled={saving}
          className="min-h-[420px] font-mono text-sm"
        />
      )}
    </section>
  );
}
