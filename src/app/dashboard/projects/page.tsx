"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
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
import { useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import { useI18n } from "@/i18n/provider";

function ProjectsPageClient() {
  const { t } = useI18n();
  const router = useRouter();
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
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />

              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">{t("projects.title")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("projects.description")}
                  </p>
                </div>
                <Button onClick={() => setShowCreate(!showCreate)} className="gap-2">
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
                </Button>
              </div>

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
                    className="border rounded-lg p-4 bg-card hover:shadow-sm transition-shadow cursor-pointer"
                    onClick={() => router.push(`/dashboard/projects/${project.id}`)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="size-5 text-primary" />
                          <h3 className="font-semibold">{project.name}</h3>
                        </div>
                        {project.description && (
                          <p className="text-sm text-muted-foreground">
                            {project.description}
                          </p>
                        )}
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
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
