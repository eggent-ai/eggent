"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";

export default function ProjectSettingsPage() {
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title="Project Model Settings" description="Edit model.json for this project/pi agent.">
      <ProjectFileEditor
        projectId={projectId}
        endpoint="model"
        filename="model.json"
        title="model.json"
        description='Use { "inheritsGlobal": true } to inherit global settings, or set provider/model/apiKey for this project.'
        rows={16}
      />
    </ProjectPageShell>
  );
}
