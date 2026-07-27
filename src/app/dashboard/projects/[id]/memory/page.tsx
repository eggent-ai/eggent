"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";
import { useI18n } from "@/i18n/provider";

export default function ProjectMemoryPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title={t("projectSub.memory.title")} description={t("projectSub.memory.description")}>
      <ProjectFileEditor
        projectId={projectId}
        endpoint="memory"
        filename="memory.md"
        title="memory.md"
        description={t("projectSub.memory.editorDescription")}
      />
    </ProjectPageShell>
  );
}
