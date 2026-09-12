import { redirect } from "next/navigation";
import { settingsScopeHref } from "@/lib/orchestrator-scope";

/**
 * A project's memory is edited on the Memory tab with the project selected.
 * The address stays so that links to it keep working.
 */
export default async function ProjectMemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(settingsScopeHref("/dashboard/memory", id));
}
