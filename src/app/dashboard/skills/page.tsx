"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, PackagePlus, Puzzle, BookText } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface BundledSkillItem {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  installed: boolean;
}

interface InstalledSkillItem {
  name: string;
  description: string;
  content: string;
  license?: string;
  compatibility?: string;
}

export default function SkillsPage() {
  const { projects, setProjects, activeProjectId } = useAppStore();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [bundledSkills, setBundledSkills] = useState<BundledSkillItem[]>([]);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillItem[]>([]);
  const [bundledSkillsLoading, setBundledSkillsLoading] = useState(true);
  const [installedSkillsLoading, setInstalledSkillsLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<InstalledSkillItem | null>(
    null
  );
  const [isSkillSheetOpen, setIsSkillSheetOpen] = useState(false);

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

  useEffect(() => {
    loadBundledSkills(selectedProjectId);
    if (!selectedProjectId) {
      setInstalledSkills([]);
      setInstalledSkillsLoading(false);
      return;
    }
    loadInstalledSkills(selectedProjectId);
  }, [selectedProjectId]);

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

  async function loadBundledSkills(projectId: string) {
    try {
      setBundledSkillsLoading(true);
      const query = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : "";
      const res = await fetch(`/api/skills${query}`);
      if (!res.ok) throw new Error("Failed to load skills");
      const data = await res.json();
      if (Array.isArray(data)) {
        setBundledSkills(
          data.map((item) => ({
            name: typeof item.name === "string" ? item.name : "unknown",
            description:
              typeof item.description === "string"
                ? item.description
                : "",
            license:
              typeof item.license === "string"
                ? item.license
                : undefined,
            compatibility:
              typeof item.compatibility === "string"
                ? item.compatibility
                : undefined,
            installed: Boolean(item.installed),
          }))
        );
      } else {
        setBundledSkills([]);
      }
    } catch {
      setBundledSkills([]);
    } finally {
      setBundledSkillsLoading(false);
    }
  }

  async function loadInstalledSkills(projectId: string) {
    try {
      setInstalledSkillsLoading(true);
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/skills`);
      if (!res.ok) throw new Error("Failed to load project skills");
      const data = await res.json();
      if (Array.isArray(data)) {
        setInstalledSkills(
          data.map((item) => ({
            name: typeof item.name === "string" ? item.name : "unknown",
            description:
              typeof item.description === "string" ? item.description : "",
            content: typeof item.content === "string" ? item.content : "",
            license:
              typeof item.license === "string" ? item.license : undefined,
            compatibility:
              typeof item.compatibility === "string"
                ? item.compatibility
                : undefined,
          }))
        );
      } else {
        setInstalledSkills([]);
      }
    } catch {
      setInstalledSkills([]);
    } finally {
      setInstalledSkillsLoading(false);
    }
  }

  async function handleInstall(skillName: string) {
    if (!selectedProjectId) return;

    setStatusMessage(null);
    setInstallingSkill(skillName);

    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProjectId,
          skillName,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        const errorText =
          typeof payload?.error === "string"
            ? payload.error
            : "Failed to install skill";
        setStatusMessage(errorText);
        return;
      }

      await Promise.all([
        loadBundledSkills(selectedProjectId),
        loadInstalledSkills(selectedProjectId),
      ]);
      const projectName =
        projects.find((project) => project.id === selectedProjectId)?.name ??
        selectedProjectId;
      setStatusMessage(`Installed "${skillName}" into project "${projectName}".`);
    } catch {
      setStatusMessage("Failed to install skill");
    } finally {
      setInstallingSkill(null);
    }
  }

  const filteredBundledSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return bundledSkills;
    return bundledSkills.filter((skill) => {
      const haystack = `${skill.name}\n${skill.description}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [bundledSkills, search]);

  const filteredInstalledSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return installedSkills;
    return installedSkills.filter((skill) => {
      const haystack = `${skill.name}\n${skill.description}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [installedSkills, search]);

  function handleOpenSkill(skill: InstalledSkillItem) {
    setSelectedSkill(skill);
    setIsSkillSheetOpen(true);
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Skills" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">Skills</h2>
                <p className="text-sm text-muted-foreground">
                  Browse installed skills of the selected project and install bundled skills.
                  Installed skills live in
                  <span className="font-mono"> .meta/skills </span>
                  and bundled skills are copied there on install.
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

                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search skills..."
                  className="md:max-w-sm"
                />
              </div>

              {statusMessage && (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  {statusMessage}
                </div>
              )}

              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <BookText className="size-4 text-primary" />
                    <h3 className="text-sm font-medium">Installed In Project</h3>
                  </div>
                  {!installedSkillsLoading && selectedProjectId && (
                    <span className="text-xs text-muted-foreground">
                      {installedSkills.length} total
                    </span>
                  )}
                </div>
                {installedSkillsLoading ? (
                  <div className="py-10 text-center text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Loading installed skills...
                  </div>
                ) : !selectedProjectId ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Select a project to view installed skills.
                  </div>
                ) : filteredInstalledSkills.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No installed skills found for this project.
                  </div>
                ) : (
                  <div className="divide-y">
                    {filteredInstalledSkills.map((skill) => (
                      <button
                        key={skill.name}
                        type="button"
                        className="w-full p-3 flex items-start gap-3 hover:bg-muted/40 transition-colors text-left"
                        onClick={() => handleOpenSkill(skill)}
                      >
                        <div className="bg-primary/10 p-2 rounded shrink-0 mt-0.5">
                          <BookText className="size-4 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{skill.name}</p>
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                            {skill.description || "No description"}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            {skill.license ? (
                              <span className="rounded border px-2 py-0.5">
                                License: {skill.license}
                              </span>
                            ) : null}
                            {skill.compatibility ? (
                              <span className="rounded border px-2 py-0.5">
                                Compatibility: {skill.compatibility}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <h3 className="text-lg font-medium">Bundled Skills Catalog</h3>
                <p className="text-sm text-muted-foreground">
                  Install prebuilt skills into the selected project. Skills are copied to
                  <span className="font-mono"> .meta/skills </span>
                  of that project.
                </p>
              </div>
              {bundledSkillsLoading ? (
                <div className="py-14 text-center text-muted-foreground flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Loading bundled skills...
                </div>
              ) : filteredBundledSkills.length === 0 ? (
                <div className="py-14 text-center text-muted-foreground">
                  No bundled skills found.
                </div>
              ) : (
                <div className="grid gap-3">
                  {filteredBundledSkills.map((skill) => (
                    <div
                      key={skill.name}
                      className="rounded-lg border bg-card p-4 flex items-start justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Puzzle className="size-4 text-primary" />
                          <h3 className="font-medium truncate">{skill.name}</h3>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {skill.description || "No description"}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {skill.license ? (
                            <span className="rounded border px-2 py-0.5">
                              License: {skill.license}
                            </span>
                          ) : null}
                          {skill.compatibility ? (
                            <span className="rounded border px-2 py-0.5">
                              Compatibility: {skill.compatibility}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <Button
                        onClick={() => handleInstall(skill.name)}
                        disabled={
                          !selectedProjectId ||
                          skill.installed ||
                          installingSkill === skill.name
                        }
                        variant={skill.installed ? "secondary" : "default"}
                        className="shrink-0 gap-2"
                      >
                        {installingSkill === skill.name ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Installing
                          </>
                        ) : skill.installed ? (
                          "Installed"
                        ) : (
                          <>
                            <PackagePlus className="size-4" />
                            Install
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>

      <Sheet open={isSkillSheetOpen} onOpenChange={setIsSkillSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col">
          <SheetHeader>
            <SheetTitle className="truncate pr-8">
              Skill: {selectedSkill?.name ?? ""}
            </SheetTitle>
            <SheetDescription>
              {selectedSkill?.description || "Skill instructions"}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <pre className="rounded-lg border bg-muted/30 p-3 text-sm font-mono whitespace-pre-wrap break-words">
              {selectedSkill?.content || "No skill content."}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
