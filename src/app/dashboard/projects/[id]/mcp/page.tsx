"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";
import { useI18n } from "@/i18n/provider";

export default function ProjectMcpPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title={t("projectSub.mcp.title")} description={t("projectSub.mcp.description")}>
      <ProjectFileEditor
        projectId={projectId}
        endpoint="mcp"
        filename=".mcp.json"
        title=".mcp.json"
        description={t("projectSub.mcp.editorDescription")}
        rows={18}
      />
    </ProjectPageShell>
  );
}
