"use client";

import { ProjectFileEditor } from "@/components/project-file-editor";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { useI18n } from "@/i18n/provider";

export default function MemoryPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();

  return (
    <SettingsShell title={t("memory.title")}>
      <SettingsPageHeader
        title={t("memory.title")}
        description={t("memory.description")}
        scope={<SettingsScopeSelect scope={scope} />}
      />
      <ProjectFileEditor key={scope.scopeId} projectId={scope.scopeId} endpoint="memory" filename="memory.md" />
    </SettingsShell>
  );
}
