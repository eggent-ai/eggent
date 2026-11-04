"use client";

import { OrchestratorInheritSwitch } from "@/components/orchestrator-inherit-switch";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { useI18n } from "@/i18n/provider";

export default function ContextPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const project = scope.isOrchestrator ? undefined : scope.projects.find((item) => item.id === scope.scopeId);

  return (
    <SettingsShell title={t("context.title")}>
      <SettingsPageHeader
        title={t("context.title")}
        description={t("context.description")}
        scope={<SettingsScopeSelect scope={scope} />}
      />
      {project && <OrchestratorInheritSwitch project={project} />}
      <ProjectFileEditor key={scope.scopeId} projectId={scope.scopeId} endpoint="context" filename="context.md" />
    </SettingsShell>
  );
}
