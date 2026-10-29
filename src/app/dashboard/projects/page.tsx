"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsContent, SettingsPageHeader } from "@/components/settings-shell";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SidePanels } from "@/components/side-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Bot,
  FolderOpen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { CreateProjectForm } from "@/components/create-project-form";
import { OrchestratorFilesNavigation } from "@/components/orchestrator-files-navigation";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAppStore } from "@/store/app-store";
import { useI18n } from "@/i18n/provider";

function ProjectsPageClient() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const { projects, setProjects, setActiveProjectId } = useAppStore();

  const shouldOpenCreate = searchParams.get("create") === "1";

  const [projectsLoading, setProjectsLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);

  const isCreateOpen = showCreate;

  const loadProjects = useCallback(async () => {
    try {
      setProjectsLoading(true);
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (Array.isArray(data)) {
        setProjects(data);
      } else {
        setProjects([]);
      }
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, [setProjects]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (shouldOpenCreate) {
      setShowCreate(true);
    }
  }, [shouldOpenCreate]);

  async function handleDelete(id: string) {
    if (!confirm(t("projects.deleteConfirm"))) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    await loadProjects();
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("projects.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <SettingsContent>

              <SettingsPageHeader
                title={t("projects.title")}
                description={t("projects.description")}
                actions={<Button onClick={() => setShowCreate(!showCreate)} className="gap-2">
                  {showCreate ? (
                    <>
                      <X className="size-4" />
                      {t("common.cancel")}
                    </>
                  ) : (
                    <>
                      <Plus className="size-4" />
                      {t("projects.new")}
                    </>
                  )}
                </Button>}
              />

              {isCreateOpen && (
                <div className="border rounded-lg p-4 bg-card space-y-4">
                  <h3 className="font-medium">{t("projects.createTitle")}</h3>
                  <CreateProjectForm
                    autoFocus
                    onCreated={async (id) => {
                      setActiveProjectId(id);
                      setShowCreate(false);
                      await loadProjects();
                    }}
                    onCancel={() => setShowCreate(false)}
                  />
                </div>
              )}

              <div className="space-y-3">
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <Bot className="size-5 text-primary" />
                    <h3 className="font-semibold">{t("orchestrator.title")}</h3>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{t("orchestrator.description")}</p>
                  <div className="mt-3">
                    <OrchestratorFilesNavigation />
                  </div>
                </div>

                {!projectsLoading && projects.length === 0 && (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
                      <EmptyTitle>{t("projects.noProjectsTitle")}</EmptyTitle>
                      <EmptyDescription>{t("projects.noProjectsDescription")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}

                {projects.map((project) => (
                  <div
                    key={project.id}
                    className="relative rounded-xl border bg-card transition-shadow hover:shadow-sm focus-within:ring-2 focus-within:ring-ring"
                  >
                    <div className="flex items-start justify-between gap-3 p-4 sm:p-5">
                      <div className="min-w-0 space-y-1 flex-1">
                        <Link href={`/dashboard/projects/${project.id}`} className="block pr-10 outline-none after:absolute after:inset-0 after:rounded-xl">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="size-5 shrink-0 text-primary" />
                          <h3 className="min-w-0 break-words font-semibold">{project.name}</h3>
                        </div>
                        {project.description && (
                          <p className="text-sm text-muted-foreground">
                            {project.description}
                          </p>
                        )}
                        </Link>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {["context.md", "memory.md", "skills/", ".mcp.json", "model.json"].map((file) => (
                            <Badge key={file} variant="outline" className="font-mono">{file}</Badge>
                          ))}
                          <span>
                            {t("common.created", { date: new Date(project.createdAt).toLocaleDateString() })}
                          </span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(project.id);
                        }}
                        className="relative z-10 text-muted-foreground hover:text-destructive"
                        aria-label={`${t("nav.deleteProject")}: ${project.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </SettingsContent>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}

export default function ProjectsPage() {
  return <ProjectsPageClient />;
}
