import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getProjectFiles, getWorkDir } from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getServerTranslator } from "@/i18n/server";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const subPath = req.nextUrl.searchParams.get("path") || "";

  const t = await getServerTranslator(req.headers.get("accept-language"));

  if (!projectId) {
    return Response.json(
      { error: t("api.error.projectIdRequired") },
      { status: 400 }
    );
  }

  const files = await getProjectFiles(projectId, subPath);
  return Response.json(files);
}

function resolveSafePath(projectId: string, filePath: string) {
  const workDir = getWorkDir(projectId);
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedPath = path.resolve(workDir, filePath);
  if (resolvedPath !== resolvedWorkDir && !resolvedPath.startsWith(resolvedWorkDir + path.sep)) {
    throw new Error("Invalid file path");
  }
  return { workDir: resolvedWorkDir, filePath: resolvedPath };
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = await req.json().catch(() => null) as {
    project?: unknown;
    path?: unknown;
    type?: unknown;
    content?: unknown;
  } | null;

  const projectId = typeof body?.project === "string" ? body.project : "";
  const filePath = typeof body?.path === "string" ? body.path.trim() : "";
  const entryType = body?.type === "directory" ? "directory" : "file";
  const content = typeof body?.content === "string" ? body.content : "";

  if (!projectId || !filePath) {
    return Response.json({ error: t("api.error.projectIdAndPathRequired") }, { status: 400 });
  }

  let resolved;
  try {
    resolved = resolveSafePath(projectId, filePath);
  } catch {
    return Response.json({ error: t("api.error.invalidFilePath") }, { status: 403 });
  }

  try {
    if (entryType === "directory") {
      await fs.mkdir(resolved.filePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(resolved.filePath), { recursive: true });
      await fs.writeFile(resolved.filePath, content, { encoding: "utf-8", flag: "wx" });
    }
    publishUiSyncEvent({
      topic: "files",
      projectId: projectId === "none" ? null : projectId,
      reason: entryType === "directory" ? "directory_created" : "file_created",
    });
    return Response.json({ success: true, projectId, path: filePath, type: entryType });
  } catch (error) {
    const message = error instanceof Error && "code" in error && error.code === "EEXIST"
      ? t("api.error.fileAlreadyExists")
      : t("api.error.failedCreatePath");
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

  if (!projectId || !filePath) {
    return Response.json(
      { error: t("api.error.projectIdAndFilePathRequired") },
      { status: 400 }
    );
  }

  let resolved;
  try {
    resolved = resolveSafePath(projectId, filePath);
  } catch {
    return Response.json(
      { error: t("api.error.invalidFilePath") },
      { status: 403 }
    );
  }

  try {
    const stat = await fs.stat(resolved.filePath);
    if (stat.isDirectory()) {
      await fs.rm(resolved.filePath, { recursive: true });
    } else {
      await fs.unlink(resolved.filePath);
    }
    publishUiSyncEvent({
      topic: "files",
      projectId: projectId === "none" ? null : projectId,
      reason: "file_deleted",
    });
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: t("api.error.fileNotFound") }, { status: 404 });
  }
}
