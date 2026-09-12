"use client";

import { ProjectFileEditor } from "@/components/project-file-editor";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { useI18n } from "@/i18n/provider";

export default function ContextPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();

  return (
    <SettingsShell title={t("context.title")}>
      <SettingsPageHeader
        title={t("context.title")}
        description={t("context.description")}
        scope={<SettingsScopeSelect scope={scope} />}
      />
      <ProjectFileEditor key={scope.scopeId} projectId={scope.scopeId} endpoint="context" filename="context.md" />
    </SettingsShell>
  );
}
