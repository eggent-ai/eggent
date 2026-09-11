"use client";

import { useParams } from "next/navigation";
import { ProjectModelSettings } from "@/components/project-model-settings";
import { ProjectPageShell } from "@/components/project-page-shell";
import { useI18n } from "@/i18n/provider";

export default function ProjectSettingsPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title={t("projectSub.settings.title")} description={t("projectSub.settings.description")}>
      <ProjectModelSettings projectId={projectId} />
    </ProjectPageShell>
  );
}
