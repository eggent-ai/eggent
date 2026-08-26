import { NextRequest } from "next/server";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getWorkDir } from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getServerTranslator } from "@/i18n/server";
import {
  parseContentLength,
  resolveConflictPolicy,
  resolveMaxUploadBytes,
  resolveSafeChildPath,
  resolveUploadTarget,
  safeRelativePath,
} from "@/lib/files/upload";

/**
 * Why one file of an upload did not land, in a form the dashboard can act on.
 */
type UploadErrorCode = "invalid" | "too_large" | "exists" | "failed";

function resolveSafeDir(projectId: string, dirPath: string) {
  const workDir = getWorkDir(projectId);
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedDir = path.resolve(workDir, dirPath || ".");
  if (resolvedDir !== resolvedWorkDir && !resolvedDir.startsWith(resolvedWorkDir + path.sep)) {
    throw new Error("Invalid directory path");
  }
  return resolvedDir;
}

function currentMaxUploadBytes(): number {
  return resolveMaxUploadBytes(process.env.EGGENT_MAX_UPLOAD_MB);
}

function limitInMegabytes(maxUploadBytes: number): number {
  return Math.round((maxUploadBytes / (1024 * 1024)) * 100) / 100;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The limit the browser should respect, so a file too large to be accepted can
 * be refused before it is sent rather than after.
 *
 * `null` means the install turned the limit off.
 */
export async function GET() {
  const maxUploadBytes = currentMaxUploadBytes();
  return Response.json({
    maxUploadBytes: Number.isFinite(maxUploadBytes) ? maxUploadBytes : null,
  });
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const maxUploadBytes = currentMaxUploadBytes();

  // A multipart body becomes memory the moment it is parsed, so a request that
  // is already too large has to be refused on its declared size, before the
  // parse. Everything below this point is bounded by the limit.
  const declaredSize = parseContentLength(req.headers.get("content-length"));
  if (declaredSize !== null && declaredSize > maxUploadBytes) {
    return Response.json(
      { error: t("api.error.uploadTooLarge", { limit: limitInMegabytes(maxUploadBytes) }) },
      { status: 413 }
    );
  }

  const formData = await req.formData();
  const projectId = String(formData.get("project") || "");
  const dirPath = String(formData.get("path") || "");
  const conflictPolicy = resolveConflictPolicy(String(formData.get("conflict") || ""));
  const files = formData.getAll("files").filter((item): item is File => item instanceof File);
  const relativePaths = formData.getAll("relativePaths").map((item) => String(item || ""));
  const directories = formData.getAll("directories").map((item) => String(item || ""));

  if (!projectId) {
    return Response.json({ error: t("api.error.projectIdRequired") }, { status: 400 });
  }
  if (files.length === 0 && directories.length === 0) {
    return Response.json({ error: t("api.error.noFilesOrDirectories") }, { status: 400 });
  }

  let targetDir: string;
  try {
    targetDir = resolveSafeDir(projectId, dirPath);
  } catch {
    return Response.json({ error: t("api.error.invalidDirectoryPath") }, { status: 403 });
  }

  await fs.mkdir(targetDir, { recursive: true });

  const uploaded: Array<{ name: string; path: string; size: number; replaced: boolean }> = [];
  const createdDirectories: string[] = [];
  // `code` is what the dashboard reads: an existing file is a question to put
  // to the user, and the message alone cannot be matched once it is translated.
  const errors: Array<{ name: string; error: string; code: UploadErrorCode }> = [];

  for (const rawDirectory of directories) {
    const safeDirectory = safeRelativePath(rawDirectory);
    if (!safeDirectory) {
      errors.push({
        name: rawDirectory || "(unnamed directory)",
        error: t("api.error.invalidDirectoryPath"),
        code: "invalid",
      });
      continue;
    }

    try {
      const targetPath = resolveSafeChildPath(targetDir, safeDirectory);
      await fs.mkdir(targetPath, { recursive: true });
      createdDirectories.push(path.posix.join(dirPath.replace(/\\/g, "/"), safeDirectory).replace(/^\.\//, ""));
    } catch {
      errors.push({ name: safeDirectory, error: t("api.error.failedCreateDirectory"), code: "failed" });
    }
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const safeFilePath = safeRelativePath(relativePaths[index] || file.name);
    if (!safeFilePath) {
      errors.push({ name: file.name || "(unnamed)", error: t("api.error.invalidFilename"), code: "invalid" });
      continue;
    }

    if (file.size > maxUploadBytes) {
      errors.push({
        name: safeFilePath,
        error: t("api.error.fileTooLarge", { limit: limitInMegabytes(maxUploadBytes) }),
        code: "too_large",
      });
      continue;
    }

    try {
      const target = await resolveUploadTarget(safeFilePath, conflictPolicy, async (candidate) =>
        pathExists(resolveSafeChildPath(targetDir, candidate))
      );
      if (!target) {
        errors.push({ name: safeFilePath, error: t("api.error.fileAlreadyExists"), code: "exists" });
        continue;
      }

      const targetPath = resolveSafeChildPath(targetDir, target.relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      // Streamed to disk rather than buffered again: the parsed body is already
      // one copy of the file, and a second one buys nothing.
      await pipeline(
        Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(targetPath, { flags: target.overwrite ? "w" : "wx" })
      );

      const relativePath = path.posix
        .join(dirPath.replace(/\\/g, "/"), target.relativePath)
        .replace(/^\.\//, "");
      uploaded.push({
        name: path.posix.basename(target.relativePath),
        path: relativePath,
        size: file.size,
        replaced: target.overwrite,
      });
    } catch (error) {
      const alreadyExists = error instanceof Error && "code" in error && error.code === "EEXIST";
      errors.push({
        name: safeFilePath,
        error: alreadyExists ? t("api.error.fileAlreadyExists") : t("api.error.failedWriteFile"),
        code: alreadyExists ? "exists" : "failed",
      });
    }
  }

  if (uploaded.length > 0 || createdDirectories.length > 0) {
    publishUiSyncEvent({
      topic: "files",
      projectId: projectId === "none" ? null : projectId,
      reason: "files_uploaded",
    });
  }

  return Response.json({ uploaded, directories: createdDirectories, errors });
}
