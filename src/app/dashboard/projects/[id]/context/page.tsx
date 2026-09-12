import { redirect } from "next/navigation";
import { settingsScopeHref } from "@/lib/orchestrator-scope";

/**
 * A project's context is edited on the Context tab with the project selected.
 * The address stays so that links to it keep working.
 */
export default async function ProjectContextPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(settingsScopeHref("/dashboard/context", id));
}
