/**
 * Client-side name of the orchestrator storage scope.
 *
 * Mirrors GLOBAL_PROJECT_ID from the project store, which cannot be imported
 * into client components because that module touches the filesystem.
 */
export const ORCHESTRATOR_SCOPE_ID = "none";
