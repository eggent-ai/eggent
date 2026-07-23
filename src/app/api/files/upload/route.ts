import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

function resolveSafeDir(projectId: string, dirPath: string) {
  const workDir = getWorkDir(projectId);
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedDir = path.resolve(workDir, dirPath || ".");
  if (resolvedDir !== resolvedWorkDir && !resolvedDir.startsWith(resolvedWorkDir + path.sep)) {
    throw new Error("Invalid directory path");
  }
  return resolvedDir;
}

function safeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized
    .split("/")
    .map((segment) => segment.replace(/[\0]/g, "").trim())
    .filter(Boolean);

  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (path.posix.isAbsolute(normalized)) return null;

  return segments.join("/");
}

function resolveSafeChildPath(rootDir: string, relativePath: string) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedChild = path.resolve(rootDir, ...relativePath.split("/"));
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Invalid child path");
  }
  return resolvedChild;
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const projectId = String(formData.get("project") || "");
  const dirPath = String(formData.get("path") || "");
  const files = formData.getAll("files").filter((item): item is File => item instanceof File);
  const relativePaths = formData.getAll("relativePaths").map((item) => String(item || ""));
  const directories = formData.getAll("directories").map((item) => String(item || ""));

  if (!projectId) {
    return Response.json({ error: "Project ID required" }, { status: 400 });
  }
  if (files.length === 0 && directories.length === 0) {
    return Response.json({ error: "No files or directories provided" }, { status: 400 });
  }

  let targetDir: string;
  try {
    targetDir = resolveSafeDir(projectId, dirPath);
  } catch {
    return Response.json({ error: "Invalid directory path" }, { status: 403 });
  }

  await fs.mkdir(targetDir, { recursive: true });

  const uploaded: Array<{ name: string; path: string; size: number }> = [];
  const createdDirectories: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const rawDirectory of directories) {
    const safeDirectory = safeRelativePath(rawDirectory);
    if (!safeDirectory) {
      errors.push({ name: rawDirectory || "(unnamed directory)", error: "Invalid directory path" });
      continue;
    }

    try {
      const targetPath = resolveSafeChildPath(targetDir, safeDirectory);
      await fs.mkdir(targetPath, { recursive: true });
      createdDirectories.push(path.posix.join(dirPath.replace(/\\/g, "/"), safeDirectory).replace(/^\.\//, ""));
    } catch {
      errors.push({ name: safeDirectory, error: "Failed to create directory" });
    }
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const safeFilePath = safeRelativePath(relativePaths[index] || file.name);
    if (!safeFilePath) {
      errors.push({ name: file.name || "(unnamed)", error: "Invalid filename" });
      continue;
    }

    try {
      const targetPath = resolveSafeChildPath(targetDir, safeFilePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(targetPath, buffer, { flag: "wx" });
      const relativePath = path.posix.join(dirPath.replace(/\\/g, "/"), safeFilePath).replace(/^\.\//, "");
      uploaded.push({ name: path.posix.basename(safeFilePath), path: relativePath, size: buffer.length });
    } catch (error) {
      const message = error instanceof Error && "code" in error && error.code === "EEXIST"
        ? "File already exists"
        : "Failed to write file";
      errors.push({ name: safeFilePath, error: message });
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
