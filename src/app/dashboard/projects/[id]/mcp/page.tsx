import { redirect } from "next/navigation";
import { settingsScopeHref } from "@/lib/orchestrator-scope";

/**
 * A project's MCP servers are edited on the MCP tab with the project selected.
 * The address stays so that links to it keep working.
 */
export default async function ProjectMcpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(settingsScopeHref("/dashboard/mcp", id));
}
