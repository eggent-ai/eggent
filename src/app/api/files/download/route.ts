import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";

const INLINE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");
  const inline = req.nextUrl.searchParams.get("inline") === "1";

  if (!projectId || !filePath) {
    return Response.json(
      { error: "Project ID and file path required" },
      { status: 400 }
    );
  }

  const workDir = getWorkDir(projectId);
  const fullPath = path.join(workDir, filePath);

  // Security check
  const resolvedPath = path.resolve(fullPath);
  const resolvedWorkDir = path.resolve(workDir);
  if (!resolvedPath.startsWith(resolvedWorkDir)) {
    return Response.json(
      { error: "Invalid file path" },
      { status: 403 }
    );
  }

  try {
    const content = await fs.readFile(fullPath);
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = INLINE_MIME_TYPES[ext] || "application/octet-stream";

    const disposition = inline && INLINE_MIME_TYPES[ext]
      ? `inline; filename="${fileName}"`
      : `attachment; filename="${fileName}"`;

    return new Response(content, {
      headers: {
        "Content-Disposition": disposition,
        "Content-Type": inline && INLINE_MIME_TYPES[ext] ? mimeType : "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}
