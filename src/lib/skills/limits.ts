/**
 * What a skill upload may be, and carry.
 *
 * A skill is mostly text - instructions, a few scripts, some reference
 * documents - so the ceilings are generous for that and small next to what an
 * archive can be made to unpack to. The file count and the total size are the
 * same two numbers the GitHub import uses: a skill that can be installed from a
 * repository should not be refused when it arrives as a file.
 *
 * No Node imports here: the page reads these to turn a file away before it is
 * sent, and the server reads them to decide the same thing again.
 */

/** The file types a skill may arrive as. A `.skill` file is a ZIP archive. */
export const SKILL_UPLOAD_EXTENSIONS = [".md", ".zip", ".skill"] as const;

/** The upload itself, before anything is unpacked. */
export const SKILL_ARCHIVE_MAX_BYTES = 30 * 1024 * 1024;

/** Everything in the skill, once unpacked. */
export const SKILL_UNPACKED_MAX_BYTES = 30 * 1024 * 1024;

export const SKILL_MAX_FILES = 600;

/** The instructions themselves; anything longer belongs in files under references/. */
export const SKILL_MD_MAX_BYTES = 512 * 1024;

/** Limits of the Agent Skills format, which the runtime applies as well. */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMPATIBILITY_MAX = 500;

/**
 * Lowercase letters, numbers and single hyphens, none at either end - the
 * shape of a skill's name, and so of its folder, which the runtime finds a
 * skill by.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillUploadKind = "markdown" | "archive";

/** How an uploaded file is to be read, from its name; null when it is neither. */
export function skillUploadKind(fileName: string): SkillUploadKind | null {
  const name = fileName.trim().toLowerCase();
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".zip") || name.endsWith(".skill")) return "archive";
  return null;
}
