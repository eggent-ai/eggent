"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, Play, Save, Trash2 } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useAppStore } from "@/store/app-store";
import type { PipelineDefinition, PipelineRun } from "@/lib/pipelines/types";

const EMPTY_STEPS = JSON.stringify(
  [
    {
      id: "agent-1",
      name: "Agent project step",
      projectId: "project-id-here",
      instructions: "Run this Eggent project as the next pi agent. Use previous artifacts as input and save handoff output in the artifacts directory."
    },
  ],
  null,
  2
);

function formatDate(value?: string) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusClass(status: string) {
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (status === "running") return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
  return "bg-muted text-muted-foreground";
}

export default function PipelinesPage() {
  const { activeProjectId, currentPath, projects, setProjects } = useAppStore();
  const syncTick = useBackgroundSync({ topics: ["pipelines", "global"] });
  const [pipelines, setPipelines] = useState<PipelineDefinition[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState("");
  const [runInput, setRunInput] = useState("Нужно выполнить цепочку агентов.");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("New pipeline");
  const [editDescription, setEditDescription] = useState("");
  const [editSteps, setEditSteps] = useState(EMPTY_STEPS);
  const [saving, setSaving] = useState(false);

  const selectedPipeline = useMemo(
    () => pipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? pipelines[0],
    [pipelines, selectedPipelineId]
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const [pipelinesRes, runsRes, projectsRes] = await Promise.all([
          fetch("/api/pipelines"),
          fetch("/api/pipeline-runs"),
          fetch("/api/projects"),
        ]);
        const [pipelinesJson, runsJson, projectsJson] = await Promise.all([
          pipelinesRes.json(),
          runsRes.json(),
          projectsRes.json(),
        ]);
        if (cancelled) return;
        const nextPipelines = Array.isArray(pipelinesJson.pipelines)
          ? pipelinesJson.pipelines
          : [];
        setPipelines(nextPipelines);
        setRuns(Array.isArray(runsJson.runs) ? runsJson.runs : []);
        if (Array.isArray(projectsJson)) {
          setProjects(projectsJson);
        }
        if (!selectedPipelineId && nextPipelines[0]) {
          setSelectedPipelineId(nextPipelines[0].id);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load pipelines");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, setProjects, syncTick]);

  function createProjectSequenceTemplate() {
    const templateProjects = projects.length > 0 ? projects : [];
    const steps = templateProjects.slice(0, 3).map((project, index) => ({
      id: project.id,
      name: project.name,
      projectId: project.id,
      instructions:
        index === 0
          ? "Run this project/pi-agent first. Save the initial output in the artifacts directory."
          : "Run this project/pi-agent after previous project agents. Read artifacts and save your handoff output.",
    }));
    setEditSteps(JSON.stringify(steps.length > 0 ? steps : JSON.parse(EMPTY_STEPS), null, 2));
  }

  function beginEdit(pipeline?: PipelineDefinition) {
    setError(null);
    if (!pipeline) {
      setEditingId(null);
      setEditName("New pipeline");
      setEditDescription("");
      setEditSteps(EMPTY_STEPS);
      return;
    }
    setEditingId(pipeline.id);
    setEditName(pipeline.name);
    setEditDescription(pipeline.description || "");
    setEditSteps(JSON.stringify(pipeline.steps, null, 2));
  }

  async function savePipeline() {
    try {
      setSaving(true);
      setError(null);
      const steps = JSON.parse(editSteps);
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error("Steps must be a non-empty JSON array");
      }
      const payload = {
        id: editingId || undefined,
        name: editName,
        description: editDescription,
        steps,
      };
      const res = await fetch(editingId ? `/api/pipelines/${editingId}` : "/api/pipelines", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save pipeline");
      setSelectedPipelineId(json.pipeline.id);
      beginEdit(json.pipeline);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save pipeline");
    } finally {
      setSaving(false);
    }
  }

  async function deletePipeline(id: string) {
    if (!confirm("Delete this pipeline?")) return;
    try {
      setError(null);
      const res = await fetch(`/api/pipelines/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to delete pipeline");
      setEditingId(null);
      setSelectedPipelineId("");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete pipeline");
    }
  }

  async function runPipeline() {
    const pipeline = selectedPipeline;
    if (!pipeline) return;
    try {
      setRunning(true);
      setError(null);
      const res = await fetch("/api/pipeline-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: pipeline.id,
          input: runInput,
          projectId: activeProjectId,
          currentPath,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to start pipeline");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to start pipeline");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Pipelines" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 p-4 md:p-6">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-2xl font-semibold">
                  <GitBranch className="size-6" /> Agent Pipelines
                </h2>
                <p className="text-sm text-muted-foreground">
                  Configure and run sequential pi-powered agent chains with artifact handoff.
                </p>
              </div>

              {error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
                <div className="space-y-4">
                  <div className="rounded-xl border bg-card p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-semibold">Definitions</h3>
                      <Button size="sm" variant="outline" onClick={() => beginEdit()}>
                        New
                      </Button>
                    </div>
                    {loading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading...
                      </div>
                    ) : pipelines.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No pipelines yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {pipelines.map((pipeline) => (
                          <button
                            key={pipeline.id}
                            onClick={() => {
                              setSelectedPipelineId(pipeline.id);
                              beginEdit(pipeline);
                            }}
                            className={`w-full rounded-lg border p-3 text-left text-sm transition hover:bg-muted/60 ${
                              selectedPipeline?.id === pipeline.id ? "border-primary bg-primary/5" : ""
                            }`}
                          >
                            <div className="font-medium">{pipeline.name}</div>
                            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {pipeline.description || `${pipeline.steps.length} steps`}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border bg-card p-4">
                    <h3 className="mb-3 font-semibold">Run pipeline</h3>
                    <select
                      value={selectedPipeline?.id || ""}
                      onChange={(event) => setSelectedPipelineId(event.target.value)}
                      className="mb-3 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      {pipelines.map((pipeline) => (
                        <option key={pipeline.id} value={pipeline.id}>
                          {pipeline.name}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={runInput}
                      onChange={(event) => setRunInput(event.target.value)}
                      className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder="Describe the task for this chain..."
                    />
                    <Button
                      className="mt-3 w-full gap-2"
                      onClick={runPipeline}
                      disabled={!selectedPipeline || running}
                    >
                      {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                      Start run
                    </Button>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border bg-card p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-semibold">Editor</h3>
                      <div className="flex gap-2">
                        {editingId ? (
                          <Button size="sm" variant="outline" onClick={() => deletePipeline(editingId)}>
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                        <Button size="sm" className="gap-2" onClick={savePipeline} disabled={saving}>
                          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                          Save
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-3">
                      <Input value={editName} onChange={(event) => setEditName(event.target.value)} />
                      <Input
                        value={editDescription}
                        onChange={(event) => setEditDescription(event.target.value)}
                        placeholder="Description"
                      />
                      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                        <div className="mb-2 font-medium text-foreground">Pipeline = sequence of Eggent projects</div>
                        <p>Each step should set <code>projectId</code>. That project directory is launched as a pi agent config with context.md, memory.md, skills/, mcp.json, cron.json and model.json.</p>
                        {projects.length > 0 ? (
                          <div className="mt-2">Available projects: {projects.map((project) => `${project.name} (${project.id})`).join(", ")}</div>
                        ) : null}
                        <Button size="sm" variant="outline" className="mt-3" onClick={createProjectSequenceTemplate}>
                          Use current projects as sequence
                        </Button>
                      </div>
                      <textarea
                        value={editSteps}
                        onChange={(event) => setEditSteps(event.target.value)}
                        className="min-h-80 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                        spellCheck={false}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border bg-card p-4">
                    <h3 className="mb-3 font-semibold">Recent runs</h3>
                    {runs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No runs yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {runs.slice(0, 12).map((run) => (
                          <div key={run.id} className="rounded-lg border p-3 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="font-medium">{run.pipelineId}</div>
                              <span className={`rounded-full px-2 py-1 text-xs ${statusClass(run.status)}`}>
                                {run.status}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              <Link className="underline-offset-2 hover:underline" href={`/dashboard/pipeline-runs/${run.id}`}>
                                {run.id}
                              </Link>{" "}
                              · {formatDate(run.updatedAt)}
                            </div>
                            <div className="mt-2 space-y-1">
                              {run.steps.map((step) => (
                                <div key={step.id} className="flex items-center justify-between gap-2 text-xs">
                                  <span>{step.name}{step.projectId ? ` · ${step.projectId}` : ""}</span>
                                  <span className={`rounded-full px-2 py-0.5 ${statusClass(step.status)}`}>
                                    {step.status}
                                  </span>
                                </div>
                              ))}
                            </div>
                            {run.error ? <div className="mt-2 text-xs text-destructive">{run.error}</div> : null}
                            <div className="mt-2 truncate text-xs text-muted-foreground">
                              Artifacts: {run.artifactsDir}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
