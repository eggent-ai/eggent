"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useAppStore } from "@/store/app-store";
import { CronSection } from "@/components/cron-section";

export default function CronPage() {
  const { projects, setProjects, activeProjectId } = useAppStore();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(false);

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId("");
      return;
    }

    const hasCurrent = projects.some((project) => project.id === selectedProjectId);
    if (hasCurrent) return;

    const activeFromSidebar = activeProjectId
      ? projects.find((project) => project.id === activeProjectId)
      : null;

    if (activeFromSidebar) {
      setSelectedProjectId(activeFromSidebar.id);
      return;
    }

    setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId, activeProjectId]);

  async function loadProjects() {
    try {
      setProjectsLoading(true);
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (Array.isArray(data)) setProjects(data);
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Cron Jobs" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold flex items-center gap-2">
                  Cron Jobs
                </h2>
                <p className="text-sm text-muted-foreground">
                  Manage scheduled jobs per project and switch between projects.
                </p>
              </div>

              <div className="flex flex-col md:flex-row gap-3">
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="rounded-md border bg-background px-3 py-2 text-sm md:w-96"
                  disabled={projectsLoading || projects.length === 0}
                >
                  {projectsLoading && (
                    <option value="">Loading projects...</option>
                  )}
                  {!projectsLoading && projects.length === 0 && (
                    <option value="">No projects available</option>
                  )}
                  {!projectsLoading &&
                    projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} ({project.id})
                      </option>
                    ))}
                </select>
              </div>

              {!selectedProjectId ? (
                <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                  Select a project to manage cron jobs.
                </div>
              ) : (
                <CronSection key={selectedProjectId} projectId={selectedProjectId} />
              )}
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
