import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathIsSensitive } from "@/lib/files/zip-walk";
import { openPlainFile } from "@/lib/files/safe-open";
import { captureBefore, versionTarget } from "@/lib/files/versions/capture";
import { absoluteOfKey, keyOfFile, projectsRootReal } from "@/lib/files/project-keys";
import { versionsEnabled } from "@/lib/files/versions/config";
import { getVersionStore } from "@/lib/files/versions/store";
import { APPROVAL_MAX_FILE_BYTES } from "@/lib/approvals/types";

/**
 * The files of this workspace an approval is about.
 *
 * A file is named by its path under the projects folder (project-keys.ts).
 * What is sent is its bytes as they are this moment, read through a handle
 * that follows no link and takes no file with a second name; a file that
 * holds credentials is never sent.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function mimeOfName(name: string): string {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || "application/octet-stream";
}

export function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export { absoluteInScope, absoluteOfKey, keyOfFile } from "@/lib/files/project-keys";

export type ReadFailure = "outside" | "missing" | "notFile" | "sensitive" | "tooLarge" | "empty";

export interface FileForApproval {
  absolute: string;
  key: string;
  name: string;
  mime: string;
  data: Buffer;
  sha256: string;
}

/** A file of this workspace as it is now, ready to be sent for approval, or why it cannot be. */
export async function readFileForApproval(absolute: string): Promise<{ file: FileForApproval } | { error: ReadFailure }> {
  const key = await keyOfFile(absolute);
  if (!key) return { error: "outside" };
  if (pathIsSensitive(key)) return { error: "sensitive" };
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return { error: "missing" };
  if (!stat.isFile()) return { error: "notFile" };
  if (stat.size > APPROVAL_MAX_FILE_BYTES) return { error: "tooLarge" };
  if (stat.size === 0) return { error: "empty" };
  const handle = await openPlainFile(absolute, { root: await projectsRootReal() });
  if (!handle) return { error: "notFile" };
  let data: Buffer;
  try {
    data = await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (data.length > APPROVAL_MAX_FILE_BYTES) return { error: "tooLarge" };
  if (!data.length) return { error: "empty" };
  const name = path.basename(absolute);
  return { file: { absolute, key, name, mime: mimeOfName(name), data, sha256: sha256Of(data) } };
}

/** What a file holds now, by its key: its hash, or why there is none. */
export async function currentStateOfKey(key: string): Promise<
  | { kind: "file"; sha256: string; size: number; seen: { mtimeMs: number; ctimeMs: number; size: number } }
  | { kind: "missing" }
  | { kind: "tooLarge"; size: number }
  | { kind: "unreadable" }
> {
  const absolute = await absoluteOfKey(key);
  if (!absolute) return { kind: "unreadable" };
  const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => (error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : undefined));
  if (stat === null) return { kind: "missing" };
  if (!stat || !stat.isFile()) return { kind: "unreadable" };
  if (stat.size > APPROVAL_MAX_FILE_BYTES) return { kind: "tooLarge", size: stat.size };
  const handle = await openPlainFile(absolute, { root: await projectsRootReal() });
  if (!handle) return { kind: "unreadable" };
  try {
    const data = await handle.readFile();
    return { kind: "file", sha256: sha256Of(data), size: data.length, seen: { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size } };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The number this state of the file has in its history, when it has one.
 * `keep`: put it in the history first when it is not there yet - a version
 * sent for approval is one its author will want to come back to, even for a
 * file whose history had not begun.
 */
export async function versionNumberOf(absolute: string, sha: string, options: { keep: boolean }): Promise<number | null> {
  if (!(await versionsEnabled())) return null;
  const target = await versionTarget(absolute);
  if (!target) return null;
  if (options.keep) await captureBefore(absolute).catch(() => undefined);
  const journal = await getVersionStore().journal(target.key);
  const last = journal?.versions[journal.versions.length - 1];
  return last && !last.deleted && last.sha === sha ? last.n : null;
}
