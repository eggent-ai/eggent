"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { OrchestratorFilesNavigation } from "@/components/orchestrator-files-navigation";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, PackagePlus, Puzzle, BookText } from "lucide-react";
import { ORCHESTRATOR_SCOPE_ID } from "@/lib/orchestrator-scope";
import { useAppStore } from "@/store/app-store";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";

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
  const { t } = useI18n();
  const { projects, setProjects, activeProjectId } = useAppStore();
  // The orchestrator is a workspace with its own skills/ directory, and it is
  // the scope a user lands in when no project is selected.
  const [selectedProjectId, setSelectedProjectId] = useState(
    activeProjectId ?? ORCHESTRATOR_SCOPE_ID
  );
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
  const isOrchestratorSelected = selectedProjectId === ORCHESTRATOR_SCOPE_ID;

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isOrchestratorSelected) return;
    if (projects.some((project) => project.id === selectedProjectId)) return;
    // A project that disappeared (or was never loaded) falls back to the
    // orchestrator rather than to an empty selection.
    setSelectedProjectId(
      activeProjectId && projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : ORCHESTRATOR_SCOPE_ID
    );
  }, [projects, selectedProjectId, activeProjectId, isOrchestratorSelected]);

  useEffect(() => {
    loadBundledSkills(selectedProjectId);
    loadInstalledSkills(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (!res.ok) throw new Error(t("skills.errors.load"));
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
      if (!res.ok) throw new Error(t("skills.errors.loadProject"));
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
            : t("skills.errors.install");
        setStatusMessage(errorText);
        return;
      }

      await Promise.all([
        loadBundledSkills(selectedProjectId),
        loadInstalledSkills(selectedProjectId),
      ]);
      const workspaceName = isOrchestratorSelected
        ? t("common.orchestrator")
        : projects.find((project) => project.id === selectedProjectId)?.name ?? selectedProjectId;
      setStatusMessage(t("skills.installedMessage", { skill: skillName, project: workspaceName }));
    } catch {
      setStatusMessage(t("skills.errors.install"));
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
        <SiteHeader title={t("skills.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">{t("skills.title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("skills.description", { path: "skills/" })}
                </p>
              </div>

              {isOrchestratorSelected ? <OrchestratorFilesNavigation /> : null}

              <div className="flex flex-col md:flex-row gap-3">
                <Select
                  value={selectedProjectId}
                  onValueChange={setSelectedProjectId}
                  disabled={projectsLoading}
                >
                  <SelectTrigger className="md:w-96">
                    <SelectValue placeholder={projectsLoading ? t("skills.loadingProjects") : t("skills.selectProject")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ORCHESTRATOR_SCOPE_ID}>
                        {t("common.orchestrator")}
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name} ({project.id})
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("skills.searchPlaceholder")}
                  className="md:max-w-sm"
                />
              </div>

              {statusMessage ? (
                <Alert>
                  <AlertDescription>{statusMessage}</AlertDescription>
                </Alert>
              ) : null}

              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <BookText className="size-4 text-primary" />
                    <h3 className="text-sm font-medium">{t("skills.installedInWorkspace")}</h3>
                  </div>
                  {!installedSkillsLoading && selectedProjectId && (
                    <span className="text-xs text-muted-foreground">
                      {t("skills.total", { count: installedSkills.length })}
                    </span>
                  )}
                </div>
                {installedSkillsLoading ? (
                  <SkeletonList rows={3} className="p-4" />
                ) : !selectedProjectId ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><BookText /></EmptyMedia>
                      <EmptyTitle>{t("skills.selectProjectTitle")}</EmptyTitle>
                      <EmptyDescription>{t("skills.selectProjectDescription")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : filteredInstalledSkills.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><BookText /></EmptyMedia>
                      <EmptyTitle>{t("skills.noInstalledTitle")}</EmptyTitle>
                      <EmptyDescription>{t("skills.noInstalledDescription")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
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
                            {skill.description || t("skills.noDescription")}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            {skill.license ? (
                              <Badge variant="outline">{t("skills.license", { license: skill.license })}</Badge>
                            ) : null}
                            {skill.compatibility ? (
                              <Badge variant="outline">{t("skills.compatibility", { compatibility: skill.compatibility })}</Badge>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <h3 className="text-lg font-medium">{t("skills.catalogTitle")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("skills.catalogDescription", { path: "skills/" })}
                </p>
              </div>
              {bundledSkillsLoading ? (
                <SkeletonList rows={4} className="p-4" />
              ) : filteredBundledSkills.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><Puzzle /></EmptyMedia>
                    <EmptyTitle>{t("skills.noBundledTitle")}</EmptyTitle>
                    <EmptyDescription>{t("skills.noBundledDescription")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
                          {skill.description || t("skills.noDescription")}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {skill.license ? (
                            <Badge variant="outline">{t("skills.license", { license: skill.license })}</Badge>
                          ) : null}
                          {skill.compatibility ? (
                            <Badge variant="outline">{t("skills.compatibility", { compatibility: skill.compatibility })}</Badge>
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
                            {t("skills.installing")}
                          </>
                        ) : skill.installed ? (
                          t("skills.installed")
                        ) : (
                          <>
                            <PackagePlus className="size-4" />
                            {t("skills.install")}
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
              {t("skills.sheetTitle", { name: selectedSkill?.name ?? "" })}
            </SheetTitle>
            <SheetDescription>
              {selectedSkill?.description || t("skills.instructions")}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <pre className="rounded-lg border bg-muted/30 p-3 text-sm font-mono whitespace-pre-wrap break-words">
              {selectedSkill?.content || t("skills.noContent")}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
