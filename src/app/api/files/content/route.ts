import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getServerTranslator } from "@/i18n/server";

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

function resolveSafePath(projectId: string, filePath: string) {
  const workDir = getWorkDir(projectId);
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedPath = path.resolve(workDir, filePath);
  if (resolvedPath !== resolvedWorkDir && !resolvedPath.startsWith(resolvedWorkDir + path.sep)) {
    throw new Error("Invalid file path");
  }
  return { workDir: resolvedWorkDir, filePath: resolvedPath };
}

function looksBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

  if (!projectId || !filePath) {
    return Response.json({ error: t("api.error.projectIdAndFilePathRequired") }, { status: 400 });
  }

  let resolved;
  try {
    resolved = resolveSafePath(projectId, filePath);
  } catch {
    return Response.json({ error: t("api.error.invalidFilePath") }, { status: 403 });
  }

  try {
    const stat = await fs.stat(resolved.filePath);
    if (!stat.isFile()) {
      return Response.json({ error: t("api.error.pathNotFile") }, { status: 400 });
    }
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return Response.json({ error: t("api.error.fileTooLargePreview"), size: stat.size }, { status: 413 });
    }

    const buffer = await fs.readFile(resolved.filePath);
    if (looksBinary(buffer)) {
      return Response.json({ error: t("api.error.binaryPreview"), binary: true }, { status: 415 });
    }

    return Response.json({
      projectId,
      path: filePath,
      filename: path.basename(filePath),
      content: buffer.toString("utf-8"),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  } catch {
    return Response.json({ error: t("api.error.fileNotFound") }, { status: 404 });
  }
}

export async function PUT(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

  if (!projectId || !filePath) {
    return Response.json({ error: t("api.error.projectIdAndFilePathRequired") }, { status: 400 });
  }

  const body = await req.json().catch(() => null) as { content?: unknown } | null;
  if (!body || typeof body.content !== "string") {
    return Response.json({ error: t("api.error.contentString") }, { status: 400 });
  }

  let resolved;
  try {
    resolved = resolveSafePath(projectId, filePath);
  } catch {
    return Response.json({ error: t("api.error.invalidFilePath") }, { status: 403 });
  }

  await fs.mkdir(path.dirname(resolved.filePath), { recursive: true });
  await fs.writeFile(resolved.filePath, body.content, "utf-8");
  const stat = await fs.stat(resolved.filePath);
  publishUiSyncEvent({
    topic: "files",
    projectId: projectId === "none" ? null : projectId,
    reason: "file_saved",
  });

  return Response.json({
    projectId,
    path: filePath,
    filename: path.basename(filePath),
    content: body.content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  });
}
