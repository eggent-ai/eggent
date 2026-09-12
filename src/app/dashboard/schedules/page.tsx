"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Clock, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import { ORCHESTRATOR_SCOPE_ID } from "@/lib/orchestrator-scope";

type PiSchedule = {
  id: string;
  name?: string;
  description?: string;
  schedule?: string;
  scheduleType?: string;
  subagent_type?: string;
  prompt?: string;
  enabled?: boolean;
  createdAt?: string;
  lastRun?: string;
  lastStatus?: string;
  nextRun?: string;
  runCount?: number;
  projectId: string | null;
  projectName: string;
  sessionId: string;
};

function formatDate(value?: string) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusVariant(job: PiSchedule): "default" | "secondary" | "destructive" | "outline" {
  if (!job.enabled) return "outline";
  if (job.lastStatus === "error") return "destructive";
  if (job.lastStatus === "running") return "default";
  return "secondary";
}

function scopeOf(job: PiSchedule): string {
  return job.projectId ?? ORCHESTRATOR_SCOPE_ID;
}

export default function PiSchedulesPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const [schedules, setSchedules] = useState<PiSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pi-schedules", { cache: "no-store" });
      const data = await response.json();
      setSchedules(Array.isArray(data.schedules) ? data.schedules : []);
    } finally {
      setLoading(false);
    }
  };

  const change = async (job: PiSchedule, action: "delete" | "retime", schedule?: string) => {
    setBusyId(job.id);
    try {
      const response = await fetch("/api/pi-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, jobId: job.id, schedule }),
      });
      if (!response.ok) throw new Error(t("schedules.changeFailed"));
      await load();
    } catch {
      window.alert(t("schedules.changeFailed"));
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(
    () => schedules.filter((job) => scopeOf(job) === scope.scopeId),
    [schedules, scope.scopeId]
  );

  // Nothing is hidden without saying where it went: schedules that belong
  // somewhere else are counted by place, each one click away.
  const elsewhere = useMemo(() => {
    const byScope = new Map<string, { id: string; name: string; count: number }>();
    for (const job of schedules) {
      const id = scopeOf(job);
      if (id === scope.scopeId) continue;
      const entry = byScope.get(id) ?? {
        id,
        name: id === ORCHESTRATOR_SCOPE_ID ? t("common.orchestrator") : job.projectName,
        count: 0,
      };
      entry.count += 1;
      byScope.set(id, entry);
    }
    return [...byScope.values()];
  }, [schedules, scope.scopeId, t]);

  return (
    <SettingsShell title={t("schedules.title")}>
      <SettingsPageHeader
        title={t("schedules.heading")}
        description={t("schedules.description")}
        actions={
          <Button variant="outline" onClick={load} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("schedules.refresh")}
          </Button>
        }
        scope={<SettingsScopeSelect scope={scope} />}
      />

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" />
            <h3 className="text-sm font-medium">{t("schedules.heading")}</h3>
          </div>
          {!loading ? (
            <span className="text-xs text-muted-foreground">
              {t("schedules.total", { count: visible.length })}
            </span>
          ) : null}
        </div>

        <div className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {t("schedules.hint")}
        </div>

        {loading ? (
          <SkeletonList rows={4} className="p-4" />
        ) : visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><CalendarClock /></EmptyMedia>
              <EmptyTitle>{t("schedules.emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {t("schedules.emptyDescription")}
              </EmptyDescription>
            </EmptyHeader>
            <Button
              className="h-11 gap-2"
              onClick={() => {
                // A schedule belongs to a live session, so it is made in
                // chat. The empty state can still hand the person the
                // sentence instead of describing the tool that does it.
                window.location.href = `/dashboard?prompt=${encodeURIComponent(t("schedules.emptyPrompt"))}`;
              }}
            >
              <CalendarClock className="size-4" />
              {t("schedules.emptyAction")}
            </Button>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("schedules.table.task")}</th>
                  <th className="px-4 py-3 font-medium">{t("schedules.table.schedule")}</th>
                  <th className="px-4 py-3 font-medium">{t("schedules.table.nextRun")}</th>
                  <th className="px-4 py-3 font-medium">{t("schedules.table.lastRun")}</th>
                  <th className="px-4 py-3 font-medium">{t("schedules.table.status")}</th>
                  <th className="px-4 py-3 font-medium"><span className="sr-only">{t("schedules.rowActions", { name: "" })}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((job) => (
                  <tr key={`${job.sessionId}:${job.id}`}>
                    <td className="px-4 py-3 align-top">
                      <div className="font-medium">{job.name || job.description || job.id}</div>
                      <div className="mt-1 line-clamp-2 max-w-md text-xs text-muted-foreground">
                        {job.prompt || job.description}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("schedules.agent", { agent: job.subagent_type || "general-purpose" })}
                        {" · "}
                        {t("schedules.session", { sessionId: job.sessionId })}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="font-mono text-xs">{job.schedule || "—"}</div>
                      <div className="text-xs text-muted-foreground">{job.scheduleType || "—"}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top">{formatDate(job.nextRun)}</td>
                    <td className="whitespace-nowrap px-4 py-3 align-top">
                      <div>{formatDate(job.lastRun)}</div>
                      <div className="text-xs text-muted-foreground">{t("schedules.runs", { count: job.runCount ?? 0 })}</div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Badge variant={statusVariant(job)}>
                        {job.enabled ? job.lastStatus || t("schedules.status.scheduled") : t("schedules.status.disabled")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-11 p-0"
                          aria-label={t("schedules.retime")}
                          title={t("schedules.retime")}
                          disabled={busyId === job.id}
                          onClick={() => {
                            const next = window.prompt(t("schedules.retimePrompt", { name: job.name || job.id }), job.schedule || "");
                            if (next && next.trim() && next.trim() !== job.schedule) change(job, "retime", next.trim());
                          }}
                        >
                          <Clock className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-11 p-0 text-muted-foreground hover:text-destructive"
                          aria-label={t("schedules.delete")}
                          title={t("schedules.delete")}
                          disabled={busyId === job.id}
                          onClick={() => {
                            if (window.confirm(t("schedules.deleteConfirm", { name: job.name || job.id }))) change(job, "delete");
                          }}
                        >
                          {busyId === job.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && elsewhere.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{t("schedules.elsewhere")}</span>
          {elsewhere.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground"
              onClick={() => scope.setScopeId(entry.id)}
            >
              {entry.name} · {entry.count}
            </button>
          ))}
        </div>
      ) : null}
    </SettingsShell>
  );
}
