/**
 * Where a file in the workspace can be looked at, rather than only saved.
 *
 * Three surfaces need the same answer - the Files page, the file tree and a
 * path mentioned in the chat - and they had two different opinions: the page
 * offered an Open button, the tree offered download only. So a skill that told
 * someone to "open it from the Files panel" sent them to the file's source in
 * the editor, which reads as the agent having produced a wall of code instead of
 * a page.
 */

/** Types the browser renders itself. Anything else is a download. */
const OPENABLE = /\.(html?|pdf|svg|png|jpe?g|gif|webp)$/i;

/**
 * Extensions worth turning into a link when they appear in a chat message.
 *
 * Wider than OPENABLE, because a file that cannot be rendered can still be
 * opened in the editor, and narrow enough that ordinary inline code - a flag, a
 * package name, a CSS value - is not mistaken for a file.
 */
const MENTIONABLE =
  /\.(html?|pdf|svg|png|jpe?g|gif|webp|md|txt|csv|tsv|json|ya?ml|js|mjs|ts|tsx|jsx|css|py|sh|sql|xlsx?|docx?|pptx?|zip)$/i;

export function isOpenableFile(path: string): boolean {
  return OPENABLE.test(path);
}

/**
 * A project-relative path, or null when the text is not one.
 *
 * Deliberately strict: no absolute paths, no traversal, no whitespace, no URLs,
 * and a known extension. A false positive here is a dead link in the middle of
 * an answer, which is worse than a path that stayed plain text.
 */
export function fileMentionPath(text: string): string | null {
  const value = text.trim();
  if (!value || value.length > 200) return null;
  if (/\s/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // http:, mailto:, data:
  if (value.startsWith("/") || value.startsWith("~")) return null;
  const normalized = value.replace(/^\.\//, "");
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  if (!MENTIONABLE.test(normalized)) return null;
  return normalized;
}

export function fileDownloadUrl(
  projectId: string,
  path: string,
  options: { inline?: boolean } = {}
): string {
  const params = new URLSearchParams({ project: projectId, path });
  if (options.inline) params.set("inline", "1");
  return `/api/files/download?${params.toString()}`;
}

export function filesPageUrl(projectId: string, path: string): string {
  const params = new URLSearchParams({ project: projectId, path });
  return `/dashboard/files?${params.toString()}`;
}
