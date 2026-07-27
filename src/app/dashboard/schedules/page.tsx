"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Loader2, RefreshCw } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useI18n } from "@/i18n/provider";

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

export default function PiSchedulesPage() {
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<PiSchedule[]>([]);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("schedules.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />

              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <h2 className="text-2xl font-semibold">{t("schedules.heading")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("schedules.description")}
                  </p>
                </div>
                <Button variant="outline" onClick={load} disabled={loading} className="gap-2 md:self-start">
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  {t("schedules.refresh")}
                </Button>
              </div>

              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <CalendarClock className="size-4 text-primary" />
                    <h3 className="text-sm font-medium">{t("schedules.heading")}</h3>
                  </div>
                  {!loading && (
                    <span className="text-xs text-muted-foreground">
                      {t("schedules.total", { count: schedules.length })}
                    </span>
                  )}
                </div>

                <div className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                  {t("schedules.hint")}
                </div>

                {loading ? (
                  <div className="py-12 text-center text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    {t("schedules.loading")}
                  </div>
                ) : schedules.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><CalendarClock /></EmptyMedia>
                      <EmptyTitle>{t("schedules.emptyTitle")}</EmptyTitle>
                      <EmptyDescription>
                        {t("schedules.emptyDescription")}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 font-medium">{t("schedules.table.task")}</th>
                          <th className="px-4 py-3 font-medium">{t("schedules.table.project")}</th>
                          <th className="px-4 py-3 font-medium">{t("schedules.table.schedule")}</th>
                          <th className="px-4 py-3 font-medium">{t("schedules.table.nextRun")}</th>
                          <th className="px-4 py-3 font-medium">{t("schedules.table.lastRun")}</th>
                          <th className="px-4 py-3 font-medium">{t("schedules.table.status")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {schedules.map((job) => (
                          <tr key={`${job.sessionId}:${job.id}`}>
                            <td className="px-4 py-3 align-top">
                              <div className="font-medium">{job.name || job.description || job.id}</div>
                              <div className="mt-1 line-clamp-2 max-w-md text-xs text-muted-foreground">
                                {job.prompt || job.description}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {t("schedules.agent", { agent: job.subagent_type || "general-purpose" })}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div>{job.projectName}</div>
                              <div className="text-xs text-muted-foreground">{t("schedules.session", { sessionId: job.sessionId })}</div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="font-mono text-xs">{job.schedule || "—"}</div>
                              <div className="text-xs text-muted-foreground">{job.scheduleType || "—"}</div>
                            </td>
                            <td className="px-4 py-3 align-top whitespace-nowrap">{formatDate(job.nextRun)}</td>
                            <td className="px-4 py-3 align-top whitespace-nowrap">
                              <div>{formatDate(job.lastRun)}</div>
                              <div className="text-xs text-muted-foreground">{t("schedules.runs", { count: job.runCount ?? 0 })}</div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <Badge variant={statusVariant(job)}>
                                {job.enabled ? job.lastStatus || t("schedules.status.scheduled") : t("schedules.status.disabled")}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
