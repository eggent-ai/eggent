"use client";

import { useParams } from "next/navigation";
import { CronSection } from "@/components/cron-section";
import { ProjectPageShell } from "@/components/project-page-shell";

export default function ProjectCronPage() {
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title="Project Cron" description="Manage cron.json for this project/pi agent.">
      <CronSection projectId={projectId} />
    </ProjectPageShell>
  );
}
