"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileText, Loader2, RefreshCw } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import type { PipelineRun } from "@/lib/pipelines/types";

function statusClass(status: string) {
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (status === "running") return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
  return "bg-muted text-muted-foreground";
}

export default function PipelineRunPage() {
  const params = useParams();
  const id = params.id as string;
  const syncTick = useBackgroundSync({ topics: ["pipelines", "global"] });
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const [runRes, artifactsRes] = await Promise.all([
          fetch(`/api/pipeline-runs/${id}`, { cache: "no-store" }),
          fetch(`/api/pipeline-runs/${id}/artifacts`, { cache: "no-store" }),
        ]);
        const [runJson, artifactsJson] = await Promise.all([runRes.json(), artifactsRes.json()]);
        if (!runRes.ok) throw new Error(runJson.error || "Failed to load run");
        if (cancelled) return;
        setRun(runJson.run);
        setArtifacts(Array.isArray(artifactsJson.artifacts) ? artifactsJson.artifacts : []);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load run");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, syncTick]);

  async function openArtifact(path: string) {
    setSelectedArtifact(path);
    setArtifactContent("Loading...");
    const res = await fetch(`/api/pipeline-runs/${id}/artifacts?path=${encodeURIComponent(path)}`);
    const json = await res.json();
    setArtifactContent(res.ok ? json.content || "" : json.error || "Failed to load artifact");
  }

  async function retryRun() {
    const res = await fetch(`/api/pipeline-runs/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wait: false }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Failed to restart run");
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Pipeline Run" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 p-4 md:p-6">
              <SettingsNavigation />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link href="/dashboard/pipelines" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="size-4" /> Back to pipelines
                  </Link>
                  <h1 className="text-2xl font-semibold">{id}</h1>
                  <p className="text-sm text-muted-foreground">Project-agent sequence run with artifact handoff.</p>
                </div>
                <Button variant="outline" className="gap-2" onClick={retryRun}>
                  <RefreshCw className="size-4" /> Continue / retry
                </Button>
              </div>

              {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}

              {loading && !run ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading...
                </div>
              ) : run ? (
                <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
                  <div className="space-y-4">
                    <div className="rounded-xl border bg-card p-4">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="font-semibold">{run.pipelineId}</div>
                        <span className={`rounded-full px-2 py-1 text-xs ${statusClass(run.status)}`}>{run.status}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">Artifacts: {run.artifactsDir}</div>
                      {run.error ? <div className="mt-2 text-sm text-destructive">{run.error}</div> : null}
                    </div>

                    <div className="rounded-xl border bg-card p-4">
                      <h3 className="mb-3 font-semibold">Project agent steps</h3>
                      <div className="space-y-3">
                        {run.steps.map((step) => (
                          <div key={step.id} className="rounded-lg border p-3 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium">{step.name}</div>
                              <span className={`rounded-full px-2 py-0.5 text-xs ${statusClass(step.status)}`}>{step.status}</span>
                            </div>
                            {step.projectId ? <div className="mt-1 text-xs text-muted-foreground">Project agent: {step.projectId}</div> : null}
                            {step.summary ? <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground line-clamp-5">{step.summary}</div> : null}
                            {step.error ? <div className="mt-2 text-xs text-destructive">{step.error}</div> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-xl border bg-card p-4">
                      <h3 className="mb-3 font-semibold">Artifacts</h3>
                      {artifacts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No artifacts yet.</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {artifacts.map((artifact) => (
                            <Button key={artifact} size="sm" variant={artifact === selectedArtifact ? "default" : "outline"} className="gap-2" onClick={() => openArtifact(artifact)}>
                              <FileText className="size-4" /> {artifact}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border bg-card p-4">
                      <h3 className="mb-3 font-semibold">{selectedArtifact || "Artifact preview"}</h3>
                      <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                        {artifactContent || "Select an artifact to preview it."}
                      </pre>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
