"use client";

import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";
import type { Project } from "@/lib/types";
import { useAppStore } from "@/store/app-store";

/**
 * Whether a project's chats also see the orchestrator beneath it: its
 * instructions, skills and MCP servers. On by default, so a project never knows
 * less than the orchestrator; off for a project that has to keep to itself.
 */
export function OrchestratorInheritSwitch({ project }: { project: Project }) {
  const { t } = useI18n();
  const projects = useAppStore((state) => state.projects);
  const setProjects = useAppStore((state) => state.setProjects);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabled = project.inheritOrchestrator !== false;

  async function onToggle(next: boolean) {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inheritOrchestrator: next }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const updated = (await response.json()) as Project;
      setProjects(projects.map((item) => (item.id === updated.id ? updated : item)));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex items-center justify-between gap-4 rounded-xl border bg-card p-5">
      <div>
        <p className="text-sm font-medium">{t("context.inherit.switch")}</p>
        <p className="text-sm text-muted-foreground">
          {failed ? t("context.inherit.failed") : enabled ? t("context.inherit.on") : t("context.inherit.off")}
        </p>
      </div>
      <div className="flex min-h-11 shrink-0 items-center">
        <Switch
          id="orchestrator-inherit"
          checked={enabled}
          disabled={saving}
          onCheckedChange={onToggle}
          aria-label={t("context.inherit.switch")}
        />
      </div>
    </section>
  );
}
