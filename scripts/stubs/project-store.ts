/**
 * Stands in for the project store when a test exercises config-store alone.
 *
 * config-store needs two things from it - where a project's files live and
 * whether a project overrides the model - and pulling the real module drags in
 * the chat store and the app's type module. Only the workspace-level paths
 * matter here, so the scope is always the workspace.
 */
export function getWorkDir(projectId: string | null): string {
  return projectId ? `${process.cwd()}/data/projects/${projectId}` : process.cwd();
}

export async function loadProjectModelSettings(): Promise<null> {
  return null;
}
