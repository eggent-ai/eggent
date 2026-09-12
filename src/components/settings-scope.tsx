"use client";

/**
 * Which workspace a settings tab is about: the orchestrator or one project.
 *
 * Model, context, memory, skills, MCP, pipelines and schedules all exist once
 * for the orchestrator and once per project. Only two tabs used to let the
 * person pick whose they were looking at; the rest showed the orchestrator's
 * and sent projects to pages of their own. The same switcher now sits on all
 * of them, and the choice travels in the address: it survives a reload, can be
 * linked to, and stays put when the person moves from one tab to the next.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, FolderOpen } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import { ORCHESTRATOR_SCOPE_ID, SCOPE_PARAM, resolveSettingsScope } from "@/lib/orchestrator-scope";
import type { Project } from "@/lib/types";
import { useAppStore } from "@/store/app-store";

export interface SettingsScope {
  /** A project id, or ORCHESTRATOR_SCOPE_ID. */
  scopeId: string;
  isOrchestrator: boolean;
  /** What to call the selection in a sentence. */
  scopeName: string;
  projects: Project[];
  setScopeId: (scopeId: string) => void;
}

export function useSettingsScope(): SettingsScope {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projects = useAppStore((state) => state.projects);
  const setProjects = useAppStore((state) => state.setProjects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setProjects(data);
        setProjectsLoaded(true);
      })
      // A failed request says nothing about which projects exist, so nothing
      // is corrected on the strength of it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setProjects]);

  const requested = searchParams.get(SCOPE_PARAM);
  const { scopeId, stale } = resolveSettingsScope({
    requested,
    activeProjectId,
    projectIds: projects.map((project) => project.id),
    projectsLoaded,
  });

  const setScopeId = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(SCOPE_PARAM, next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  // An address naming a project that has since been deleted is corrected
  // rather than kept, or every reload would go on asking for it.
  useEffect(() => {
    if (stale && requested) setScopeId(ORCHESTRATOR_SCOPE_ID);
  }, [stale, requested, setScopeId]);

  const isOrchestrator = scopeId === ORCHESTRATOR_SCOPE_ID;
  const scopeName = isOrchestrator
    ? t("common.orchestrator")
    : projects.find((project) => project.id === scopeId)?.name ?? scopeId;

  return { scopeId, isOrchestrator, scopeName, projects, setScopeId };
}

export function SettingsScopeSelect({ scope }: { scope: SettingsScope }) {
  const { t } = useI18n();
  // Until the list arrives a project's name is unknown, and a trigger spelling
  // out a bare id reads like a fault rather than like loading.
  const known = scope.isOrchestrator || scope.projects.some((project) => project.id === scope.scopeId);

  return (
    <Select value={known ? scope.scopeId : ""} onValueChange={scope.setScopeId}>
      <SelectTrigger aria-label={t("settings.scope.label")} className="w-full sm:w-64">
        <SelectValue placeholder={t("settings.scope.loading")} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ORCHESTRATOR_SCOPE_ID}>
            <Bot />
            {t("common.orchestrator")}
          </SelectItem>
        </SelectGroup>
        {scope.projects.length > 0 ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              {scope.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <FolderOpen />
                  {project.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}
