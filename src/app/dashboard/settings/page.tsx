"use client";

import { ProjectModelSettings } from "@/components/project-model-settings";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { WorkspaceModelSettings } from "@/components/workspace-model-settings";
import { useI18n } from "@/i18n/provider";

/**
 * Settings open here, and so does the first run after sign-up: a model is the
 * one thing a new workspace cannot work without.
 *
 * For the orchestrator this is the workspace's own model - the one every
 * project follows unless it has one of its own - and for a project it is that
 * project's choice.
 */
export default function ModelsPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();

  return (
    <SettingsShell title={t("settings.nav.models")}>
      <SettingsPageHeader
        title={t("settings.models.title")}
        description={t("settings.models.description")}
        scope={<SettingsScopeSelect scope={scope} />}
      />
      {scope.isOrchestrator ? (
        <WorkspaceModelSettings />
      ) : (
        <ProjectModelSettings key={scope.scopeId} projectId={scope.scopeId} />
      )}
    </SettingsShell>
  );
}
