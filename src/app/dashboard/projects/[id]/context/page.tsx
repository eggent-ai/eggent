"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";

export default function ProjectContextPage() {
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title="Project Context" description="Edit the context.md file injected into this project agent.">
      <ProjectFileEditor
        projectId={projectId}
        endpoint="context"
        filename="context.md"
        title="context.md"
        description="Primary instructions and operating context for this project agent."
      />
    </ProjectPageShell>
  );
}
