"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";
import { useI18n } from "@/i18n/provider";

export default function ProjectContextPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title={t("projectSub.context.title")} description={t("projectSub.context.description")}>
      <ProjectFileEditor
        projectId={projectId}
        endpoint="context"
        filename="context.md"
        title="context.md"
        description={t("projectSub.context.editorDescription")}
      />
    </ProjectPageShell>
  );
}
