import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathIsSensitive } from "@/lib/files/zip-walk";
import { openPlainFile } from "@/lib/files/safe-open";
import { projectFolderIsLink, workDirOrNull } from "@/lib/files/workspace-root";
import { captureAfter, captureBefore, OutsideFolderError, writeFileInside } from "@/lib/files/versions/capture";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

/**
 * The files of a page shown on screen, and the words changed on it written
 * back - for the routes under /api/files/page*.
 */

/** A page is read whole to be marked for editing; past this it is shown as it is. */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export function sourceSha(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

export interface ScopeFile {
  absolute: string;
  /** The scope's folder, every link on its way resolved. */
  root: string;
  /** The path under the scope's folder, with forward slashes. */
  relative: string;
}

/**
 * A file of a scope by its path in it: a plain path with no step out of the
 * folder, not a file holding credentials, in a project whose folder is not a
 * link. Whether it exists is the caller's to find out.
 */
export async function scopeFile(project: string, filePath: string): Promise<ScopeFile | null> {
  const workDir = workDirOrNull(project);
  if (!workDir || (await projectFolderIsLink(project))) return null;
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) return null;
  const relative = segments.join("/");
  if (pathIsSensitive(relative)) return null;
  const root = await fs.realpath(workDir).catch(() => null);
  if (!root) return null;
  return { absolute: path.join(root, ...segments), root, relative };
}

/** A plain file's bytes, through a handle that follows no link and takes no file with a second name. */
export async function readScopeFile(file: ScopeFile, maxBytes: number): Promise<Buffer | "missing" | "tooLarge" | "unreadable"> {
  const stat = await fs.lstat(file.absolute).catch(() => null);
  if (!stat) return "missing";
  if (!stat.isFile()) return "unreadable";
  if (stat.size > maxBytes) return "tooLarge";
  const handle = await openPlainFile(file.absolute, { root: file.root });
  if (!handle) return "unreadable";
  try {
    return await handle.readFile();
  } catch {
    return "unreadable";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Writes a page's new text as the person's save: what it held is kept in its
 * history first, the new text becomes the next version, and the screens that
 * show the file hear of it.
 */
export async function savePageAsPerson(project: string, file: ScopeFile, content: string): Promise<"saved" | "tooLarge" | "outside" | "failed"> {
  const before = await captureBefore(file.absolute).catch(() => "unreadable" as const);
  if (before === "too-large") return "tooLarge";
  try {
    await writeFileInside(file.absolute, content, file.root);
  } catch (error) {
    return error instanceof OutsideFolderError ? "outside" : "failed";
  }
  await captureAfter(file.absolute, { kind: "person" }, { onlyIfTracked: true }).catch(() => undefined);
  publishUiSyncEvent({ topic: "files", projectId: project === "none" ? null : project, reason: "file_saved" });
  return "saved";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export function pageContentType(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

export function isHtmlName(fileName: string): boolean {
  return /\.html?$/i.test(fileName);
}
