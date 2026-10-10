"use client";

import { LearnedMemory } from "@/components/learned-memory";
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
      {/* What the agent keeps by itself belongs to the person, not to a project. */}
      {scope.isOrchestrator ? <LearnedMemory /> : null}
      <ProjectFileEditor key={scope.scopeId} projectId={scope.scopeId} endpoint="memory" filename="memory.md" />
    </SettingsShell>
  );
}
