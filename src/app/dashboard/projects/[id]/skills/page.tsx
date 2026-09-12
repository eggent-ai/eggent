import { redirect } from "next/navigation";
import { settingsScopeHref } from "@/lib/orchestrator-scope";

/**
 * A project's skills are managed on the Skills tab with the project selected.
 * The address stays so that links to it keep working.
 */
export default async function ProjectSkillsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(settingsScopeHref("/dashboard/skills", id));
}
