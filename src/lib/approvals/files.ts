import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathIsSensitive } from "@/lib/files/zip-walk";
import { openPlainFile } from "@/lib/files/safe-open";
import { captureBefore, projectsDirectory, versionTarget } from "@/lib/files/versions/capture";
import { versionsEnabled } from "@/lib/files/versions/config";
import { getVersionStore } from "@/lib/files/versions/store";
import { getWorkDir } from "@/lib/storage/project-store";
import { APPROVAL_MAX_FILE_BYTES } from "@/lib/approvals/types";

/**
 * The files of this workspace an approval is about.
 *
 * A file is named by its path under the projects folder - the same key its
 * history goes by - so one file is one approval whichever project's screen it
 * was sent from. What is sent is its bytes as they are this moment, read
 * through a handle that follows no link and takes no file with a second name;
 * a file that holds credentials is never sent.
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

let realRoot: { of: string; real: string } | null = null;

/** The projects folder with every link on its way resolved, which a real path is compared with. */
async function projectsRoot(): Promise<string> {
  const configured = projectsDirectory();
  if (realRoot?.of === configured) return realRoot.real;
  realRoot = { of: configured, real: await fs.realpath(configured).catch(() => configured) };
  return realRoot.real;
}

/** The absolute path a scope and a path in it name, or null when it leaves the scope's folder. */
export function absoluteInScope(projectId: string, filePath: string): string | null {
  let workDir: string;
  try {
    workDir = path.resolve(getWorkDir(projectId));
  } catch {
    return null;
  }
  const absolute = path.resolve(workDir, filePath);
  return absolute.startsWith(workDir + path.sep) ? absolute : null;
}

const BAD_SEGMENT = (segment: string) => !segment || segment === "." || segment === "..";

/** The path of a file under the projects folder, with forward slashes; null for anything outside it. */
export async function keyOfFile(absolute: string): Promise<string | null> {
  const root = await projectsRoot();
  const parent = await fs.realpath(path.dirname(path.resolve(absolute))).catch(() => null);
  if (!parent || (parent !== root && !parent.startsWith(root + path.sep))) return null;
  const key = path.relative(root, path.join(parent, path.basename(absolute))).split(path.sep).join("/");
  if (!key || key.startsWith("..") || key.split("/").some(BAD_SEGMENT)) return null;
  return key;
}

/** Where a key is on disk; null for a key that is not a plain path under the projects folder. */
export async function absoluteOfKey(key: string): Promise<string | null> {
  const segments = String(key || "").split("/");
  if (!key || segments.some(BAD_SEGMENT) || segments.some((segment) => segment.includes("\\"))) return null;
  return path.join(await projectsRoot(), ...segments);
}

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
  const handle = await openPlainFile(absolute, { root: await projectsRoot() });
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
  const handle = await openPlainFile(absolute, { root: await projectsRoot() });
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
