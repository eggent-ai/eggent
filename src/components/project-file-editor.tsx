"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ProjectFileEditorProps {
  projectId: string;
  endpoint: "context" | "memory" | "model" | "mcp";
  title: string;
  description: string;
  filename: string;
  rows?: number;
}

export function ProjectFileEditor({
  projectId,
  endpoint,
  title,
  description,
  filename,
  rows = 18,
}: ProjectFileEditorProps) {
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setStatus(null);
        setError(null);
        const res = await fetch(`/api/projects/${projectId}/${endpoint}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `Failed to load ${filename}`);
        if (cancelled) return;
        const next = typeof json.content === "string" ? json.content : "";
        setContent(next);
        setDraft(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : `Failed to load ${filename}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, endpoint, filename]);

  async function save() {
    try {
      setSaving(true);
      setStatus(null);
      setError(null);
      const res = await fetch(`/api/projects/${projectId}/${endpoint}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to save ${filename}`);
      const next = typeof json.content === "string" ? json.content : draft;
      setContent(next);
      setDraft(next);
      setStatus(`${filename} saved.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : `Failed to save ${filename}`);
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft !== content;

  return (
    <section className="rounded-xl border bg-card p-4 md:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-mono text-muted-foreground">{filename}</div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button onClick={save} disabled={saving || loading || !dirty} className="gap-2">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save
        </Button>
      </div>

      {status ? <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{status}</div> : null}
      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading {filename}...
        </div>
      ) : (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={rows}
          disabled={saving}
          className="w-full rounded-lg border bg-muted/30 p-3 text-sm font-mono whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
        />
      )}
    </section>
  );
}
