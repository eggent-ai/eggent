import path from "path";

/**
 * Where learning keeps its files.
 *
 * Everything the person should be able to see, read and edit lives in the
 * orchestrator's own directory, next to context.md and memory.md: the notes
 * file and the skills. That directory is shared with the desktop app, so what
 * the agent learns on one computer is there on the other.
 *
 * Everything that is the machine's own bookkeeping - counters, usage, the
 * journal - lives under data/learning, outside what is shared. Two computers
 * keeping one counter file would only produce conflict copies.
 *
 * Resolved on every call rather than once at import: the working directory is
 * the data root, and a test moves it before it loads anything.
 */

export const LEARNED_FILENAME = "learned.md";
export const SKILLS_DIRNAME = "skills";
export const ARCHIVE_DIRNAME = ".archive";

function dataDir(): string {
  return path.join(process.cwd(), "data");
}

/** The orchestrator's working directory, where its own files sit. */
export function orchestratorDir(): string {
  return path.join(dataDir(), "projects");
}

export function learnedFilePath(): string {
  return path.join(orchestratorDir(), LEARNED_FILENAME);
}

export function orchestratorSkillsDir(): string {
  return path.join(orchestratorDir(), SKILLS_DIRNAME);
}

export function skillsArchiveDir(): string {
  return path.join(orchestratorSkillsDir(), ARCHIVE_DIRNAME);
}

/** Machine-local bookkeeping; never shared. */
export function learningStateDir(): string {
  return path.join(dataDir(), "learning");
}
