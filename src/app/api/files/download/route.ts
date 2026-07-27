import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";
import { getServerTranslator } from "@/i18n/server";

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

  if (!projectId || !filePath) {
    return Response.json(
      { error: t("api.error.projectIdAndFilePathRequired") },
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
      { error: t("api.error.invalidFilePath") },
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
    return Response.json({ error: t("api.error.fileNotFound") }, { status: 404 });
  }
}
