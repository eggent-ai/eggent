/**
 * Client-side name of the orchestrator storage scope.
 *
 * Mirrors GLOBAL_PROJECT_ID from the project store, which cannot be imported
 * into client components because that module touches the filesystem.
 */
export const ORCHESTRATOR_SCOPE_ID = "none";

/**
 * The query parameter naming the scope a settings tab shows.
 *
 * `none` in it means the orchestrator, and has to be written out when that is
 * what is meant: a tab opened with no scope at all follows the project the
 * chat is in.
 */
export const SCOPE_PARAM = "project";

/**
 * Which scope a settings tab shows, and whether the one asked for is gone.
 *
 * The address wins. Without one the tab opens on the project the chat is in,
 * since that is the one a person arriving from it came to change, and on the
 * orchestrator when no project is open. A project that no longer exists falls
 * back to the orchestrator - but only once the list has loaded, because an
 * empty list is the ordinary first state of a page load, not evidence that a
 * project was deleted.
 */
export function resolveSettingsScope(input: {
  requested: string | null | undefined;
  activeProjectId: string | null | undefined;
  projectIds: readonly string[];
  projectsLoaded: boolean;
}): { scopeId: string; stale: boolean } {
  const wanted = input.requested?.trim() || input.activeProjectId || ORCHESTRATOR_SCOPE_ID;
  if (wanted === ORCHESTRATOR_SCOPE_ID || !input.projectsLoaded || input.projectIds.includes(wanted)) {
    return { scopeId: wanted, stale: false };
  }
  return { scopeId: ORCHESTRATOR_SCOPE_ID, stale: true };
}

/** The address of a settings tab showing the given scope. */
export function settingsScopeHref(path: string, scopeId: string | null | undefined): string {
  return scopeId ? `${path}?${SCOPE_PARAM}=${encodeURIComponent(scopeId)}` : path;
}

/** The project a dashboard address is about, when its path names one. */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/dashboard\/projects\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
