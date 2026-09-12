import { redirect } from "next/navigation";
import { settingsScopeHref } from "@/lib/orchestrator-scope";

/**
 * A project's model is chosen on the Models tab with the project selected.
 * The address stays so that links to it keep working.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(settingsScopeHref("/dashboard/settings", id));
}
