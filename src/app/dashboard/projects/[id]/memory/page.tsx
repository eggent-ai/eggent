"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";

export default function ProjectMemoryPage() {
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title="Project Memory" description="Edit the memory.md file used by this project agent.">
      <ProjectFileEditor
        projectId={projectId}
        endpoint="memory"
        filename="memory.md"
        title="memory.md"
        description="Plain Markdown memory. The agent reads, searches, and appends this file through Eggent memory tools."
      />
    </ProjectPageShell>
  );
}
