"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Clock3,
  History,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronRunStatus = "ok" | "error" | "skipped";

type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  payload: {
    kind: "agentTurn";
    message: string;
    telegramChatId?: string;
    timeoutSeconds?: number;
  };
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: CronRunStatus;
    lastError?: string;
    lastDurationMs?: number;
  };
};

type CronStatus = {
  projectId: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

type CronRunLogEntry = {
  ts: number;
  status: CronRunStatus;
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

type CronFormState = {
  name: string;
  description: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  scheduleKind: "every" | "at" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  message: string;
  telegramChatId: string;
  timeoutSeconds: string;
};

const DEFAULT_FORM: CronFormState = {
  name: "",
  description: "",
  enabled: true,
  deleteAfterRun: true,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 9 * * 1-5",
  cronTz: "",
  message: "",
  telegramChatId: "",
  timeoutSeconds: "",
};

function formatDateTime(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  return new Date(ms).toLocaleString();
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  return `${(ms / 1_000).toFixed(1)}s`;
}

function scheduleSummary(schedule: CronSchedule): string {
  if (schedule.kind === "at") {
    return `At ${schedule.at}`;
  }
  if (schedule.kind === "every") {
    return `Every ${schedule.everyMs}ms`;
  }
  return schedule.tz ? `Cron ${schedule.expr} (${schedule.tz})` : `Cron ${schedule.expr}`;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // no-op
  }
  return `Request failed (${res.status})`;
}

interface CronSectionProps {
  projectId: string;
}

export function CronSection({ projectId }: CronSectionProps) {
  const [form, setForm] = useState<CronFormState>(DEFAULT_FORM);
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [runs, setRuns] = useState<CronRunLogEntry[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => (selectedJobId ? jobs.find((job) => job.id === selectedJobId) ?? null : null),
    [jobs, selectedJobId]
  );

  const loadStatusAndJobs = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [statusRes, jobsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/cron/status`),
        fetch(`/api/projects/${projectId}/cron?includeDisabled=true`),
      ]);

      if (!statusRes.ok) {
        throw new Error(await readErrorMessage(statusRes));
      }
      if (!jobsRes.ok) {
        throw new Error(await readErrorMessage(jobsRes));
      }

      const statusData = (await statusRes.json()) as CronStatus;
      const jobsData = (await jobsRes.json()) as { jobs?: CronJob[] };
      const nextJobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];

      setStatus(statusData);
      setJobs(nextJobs);

      // Keep selectedJobId/runs even when a one-shot job disappears from active jobs
      // after successful run (deleteAfterRun=true). Run history is persisted separately.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  async function loadRuns(jobId: string) {
    setError(null);
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/cron/${jobId}/runs?limit=100`);
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      const data = (await res.json()) as { entries?: CronRunLogEntry[] };
      const entries = Array.isArray(data.entries) ? data.entries : [];
      setSelectedJobId(jobId);
      setRuns([...entries].sort((a, b) => b.ts - a.ts));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunsLoading(false);
    }
  }

  useEffect(() => {
    void loadStatusAndJobs();
  }, [loadStatusAndJobs]);

  async function createJob() {
    setError(null);
    setBusy(true);
    try {
      const name = form.name.trim();
      if (!name) {
        throw new Error("Job name is required.");
      }
      const message = form.message.trim();
      if (!message) {
        throw new Error("Agent message is required.");
      }

      let schedule: CronSchedule;
      if (form.scheduleKind === "at") {
        const atMs = Date.parse(form.scheduleAt);
        if (!Number.isFinite(atMs)) {
          throw new Error("Invalid date/time for 'At' schedule.");
        }
        schedule = { kind: "at", at: new Date(atMs).toISOString() };
      } else if (form.scheduleKind === "every") {
        const amount = Number(form.everyAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("Interval amount must be a positive number.");
        }
        const multiplier =
          form.everyUnit === "minutes"
            ? 60_000
            : form.everyUnit === "hours"
              ? 3_600_000
              : 86_400_000;
        schedule = { kind: "every", everyMs: Math.floor(amount * multiplier) };
      } else {
        const expr = form.cronExpr.trim();
        if (!expr) {
          throw new Error("Cron expression is required.");
        }
        schedule = {
          kind: "cron",
          expr,
          tz: form.cronTz.trim() || undefined,
        };
      }

      const timeoutValue = Number(form.timeoutSeconds);
      const timeoutSeconds =
        Number.isFinite(timeoutValue) && timeoutValue > 0 ? Math.floor(timeoutValue) : undefined;

      const res = await fetch(`/api/projects/${projectId}/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: form.description.trim() || undefined,
          enabled: form.enabled,
          deleteAfterRun: form.deleteAfterRun,
          schedule,
          payload: {
            kind: "agentTurn",
            message,
            telegramChatId: form.telegramChatId.trim() || undefined,
            timeoutSeconds,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }

      setForm((prev) => ({
        ...prev,
        name: "",
        description: "",
        message: "",
        telegramChatId: "",
        timeoutSeconds: "",
      }));
      await loadStatusAndJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleJob(job: CronJob, enabled: boolean) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/cron/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      await loadStatusAndJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runNow(job: CronJob) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/cron/${job.id}/run`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      await Promise.all([loadStatusAndJobs(), loadRuns(job.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeJob(job: CronJob) {
    const confirmed = confirm(`Delete cron job "${job.name}"?`);
    if (!confirmed) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/cron/${job.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      if (selectedJobId === job.id) {
        setSelectedJobId(null);
        setRuns([]);
      }
      await loadStatusAndJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium flex items-center gap-2">
          <CalendarClock className="size-5 text-primary" />
          Cron Jobs
        </h3>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void loadStatusAndJobs()}
          disabled={loading || busy}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="text-sm border border-destructive/30 bg-destructive/10 text-destructive rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="border rounded-lg bg-card p-4 space-y-3">
          <p className="text-sm font-medium">Scheduler Status</p>
          <div className="text-sm text-muted-foreground">
            <p>Project: {status?.projectId ?? projectId}</p>
            <p>Jobs: {status?.jobs ?? (loading ? "…" : 0)}</p>
            <p>Next wake: {formatDateTime(status?.nextWakeAtMs ?? null)}</p>
          </div>
        </div>

        <div className="border rounded-lg bg-card p-4 space-y-3 lg:col-span-2">
          <p className="text-sm font-medium">Create Job</p>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="cron-name">Name</Label>
              <Input
                id="cron-name"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Daily summary"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-description">Description</Label>
              <Input
                id="cron-description"
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-schedule-kind">Schedule</Label>
              <select
                id="cron-schedule-kind"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={form.scheduleKind}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    scheduleKind: e.target.value as CronFormState["scheduleKind"],
                  }))
                }
              >
                <option value="every">Every</option>
                <option value="at">At</option>
                <option value="cron">Cron</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-timeout">Timeout (seconds)</Label>
              <Input
                id="cron-timeout"
                value={form.timeoutSeconds}
                onChange={(e) => setForm((prev) => ({ ...prev, timeoutSeconds: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </div>

          {form.scheduleKind === "at" && (
            <div className="space-y-2">
              <Label htmlFor="cron-at">Run At</Label>
              <Input
                id="cron-at"
                type="datetime-local"
                value={form.scheduleAt}
                onChange={(e) => setForm((prev) => ({ ...prev, scheduleAt: e.target.value }))}
              />
            </div>
          )}

          {form.scheduleKind === "every" && (
            <div className="grid gap-3 md:grid-cols-[1fr_180px]">
              <div className="space-y-2">
                <Label htmlFor="cron-every-amount">Every</Label>
                <Input
                  id="cron-every-amount"
                  value={form.everyAmount}
                  onChange={(e) => setForm((prev) => ({ ...prev, everyAmount: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cron-every-unit">Unit</Label>
                <select
                  id="cron-every-unit"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={form.everyUnit}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      everyUnit: e.target.value as CronFormState["everyUnit"],
                    }))
                  }
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </select>
              </div>
            </div>
          )}

          {form.scheduleKind === "cron" && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cron-expr">Cron Expression</Label>
                <Input
                  id="cron-expr"
                  value={form.cronExpr}
                  onChange={(e) => setForm((prev) => ({ ...prev, cronExpr: e.target.value }))}
                  placeholder="0 9 * * 1-5"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cron-tz">Time Zone</Label>
                <Input
                  id="cron-tz"
                  value={form.cronTz}
                  onChange={(e) => setForm((prev) => ({ ...prev, cronTz: e.target.value }))}
                  placeholder="Optional, e.g. UTC"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="cron-message">Agent Message</Label>
            <textarea
              id="cron-message"
              value={form.message}
              onChange={(e) => setForm((prev) => ({ ...prev, message: e.target.value }))}
              placeholder="What should the agent do on each run?"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[88px] resize-y"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cron-telegram-chat-id">Telegram Chat ID (optional)</Label>
            <Input
              id="cron-telegram-chat-id"
              value={form.telegramChatId}
              onChange={(e) => setForm((prev) => ({ ...prev, telegramChatId: e.target.value }))}
              placeholder="e.g. 123456789"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.deleteAfterRun}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, deleteAfterRun: e.target.checked }))
                }
              />
              Delete after one-shot run
            </label>
          </div>

          <Button onClick={() => void createJob()} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />}
            Create Job
          </Button>
        </div>
      </div>

      <div className="border rounded-lg bg-card">
        <div className="px-4 py-3 border-b">
          <p className="text-sm font-medium">Jobs</p>
        </div>
        {loading ? (
          <div className="p-8 text-muted-foreground text-sm flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Loading jobs...
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No cron jobs yet.
          </div>
        ) : (
          <div className="divide-y">
            {jobs.map((job) => (
              <div key={job.id} className="p-4 space-y-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <p className="font-medium text-sm">{job.name}</p>
                    {job.description && (
                      <p className="text-sm text-muted-foreground">{job.description}</p>
                    )}
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>Schedule: {scheduleSummary(job.schedule)}</p>
                      <p>Next run: {formatDateTime(job.state.nextRunAtMs)}</p>
                      <p>Last run: {formatDateTime(job.state.lastRunAtMs)}</p>
                      <p>Last duration: {formatDuration(job.state.lastDurationMs)}</p>
                      {job.state.lastStatus && <p>Last status: {job.state.lastStatus}</p>}
                      {job.state.lastError && (
                        <p className="text-destructive">Error: {job.state.lastError}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggleJob(job, !job.enabled)}
                      disabled={busy}
                    >
                      {job.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runNow(job)}
                      disabled={busy}
                      className="gap-1"
                    >
                      <Play className="size-3.5" />
                      Run now
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadRuns(job.id)}
                      disabled={busy}
                      className="gap-1"
                    >
                      <History className="size-3.5" />
                      Runs
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void removeJob(job)}
                      disabled={busy}
                      className="text-muted-foreground hover:text-destructive"
                      title="Delete job"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border rounded-lg bg-card">
        <div className="px-4 py-3 border-b">
          <p className="text-sm font-medium flex items-center gap-2">
            <Clock3 className="size-4 text-primary" />
            Run History{" "}
            {selectedJob
              ? `for "${selectedJob.name}"`
              : selectedJobId
                ? `(job ${selectedJobId})`
                : ""}
          </p>
        </div>
        {selectedJobId === null ? (
          <div className="p-4 text-sm text-muted-foreground">
            Select a job and click &quot;Runs&quot; to inspect history.
          </div>
        ) : !selectedJob ? (
          runsLoading ? (
            <div className="p-8 text-muted-foreground text-sm flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Loading run history...
            </div>
          ) : runs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              Job is no longer in active list (likely one-shot auto-delete). No runs found yet.
            </div>
          ) : (
            <div className="divide-y">
              {runs.map((entry, idx) => (
                <div key={`${entry.ts}-${idx}`} className="p-4 text-sm space-y-1">
                  <p>
                    <span className="font-medium">{entry.status.toUpperCase()}</span>{" "}
                    at {formatDateTime(entry.runAtMs ?? entry.ts)}
                  </p>
                  <p className="text-muted-foreground">
                    Duration: {formatDuration(entry.durationMs)} | Next run:{" "}
                    {formatDateTime(entry.nextRunAtMs)}
                  </p>
                  {entry.summary && <p>{entry.summary}</p>}
                  {entry.error && <p className="text-destructive">{entry.error}</p>}
                </div>
              ))}
            </div>
          )
        ) : runsLoading ? (
          <div className="p-8 text-muted-foreground text-sm flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Loading run history...
          </div>
        ) : runs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No run history yet.</div>
        ) : (
          <div className="divide-y">
            {runs.map((entry, idx) => (
              <div key={`${entry.ts}-${idx}`} className="p-4 text-sm space-y-1">
                <p>
                  <span className="font-medium">{entry.status.toUpperCase()}</span>{" "}
                  at {formatDateTime(entry.runAtMs ?? entry.ts)}
                </p>
                <p className="text-muted-foreground">
                  Duration: {formatDuration(entry.durationMs)} | Next run:{" "}
                  {formatDateTime(entry.nextRunAtMs)}
                </p>
                {entry.summary && <p>{entry.summary}</p>}
                {entry.error && <p className="text-destructive">{entry.error}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
