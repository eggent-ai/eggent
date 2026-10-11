import fs from "node:fs/promises";
import { getWorkDir, isOrchestratorScope } from "@/lib/storage/project-store";

/**
 * Whether a project's folder is itself a link to somewhere else.
 *
 * Everything that serves files out of a project - the archive, the card under an
 * answer, the button that sends one to Telegram - judges a path by where it
 * lands relative to the project's folder. A folder that is a link to the data
 * directory moves that line outward: every file of the workspace is then
 * "inside" it. The agent has a shell and can make such a link, so a project
 * whose folder is one is served nothing. The orchestrator's folder is the
 * projects directory itself, which an operator may have placed behind a link on
 * purpose, and is not asked.
 */
export async function projectFolderIsLink(projectId?: string | null): Promise<boolean> {
  if (isOrchestratorScope(projectId)) return false;
  try {
    return (await fs.lstat(getWorkDir(projectId))).isSymbolicLink();
  } catch {
    // Missing: the caller finds that out in its own way.
    return false;
  }
}

/** The folder of a project or the orchestrator, or null when the id cannot name one. */
export function workDirOrNull(projectId?: string | null): string | null {
  try {
    return getWorkDir(projectId);
  } catch {
    return null;
  }
}
