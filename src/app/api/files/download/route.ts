import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

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

    return new Response(content, {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/octet-stream",
      },
    });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}
