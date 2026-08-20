import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";
import { getServerTranslator } from "@/i18n/server";

/**
 * Content types worth opening in a browser rather than saving to disk.
 *
 * Anything not listed falls back to plain text, which renders safely and never
 * turns an unknown extension into something the browser tries to execute.
 */
const INLINE_CONTENT_TYPES: Record<string, string> = {
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
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
};

function inlineContentType(fileName: string): string {
  return INLINE_CONTENT_TYPES[path.extname(fileName).toLowerCase()] || "text/plain; charset=utf-8";
}

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

    // Opening a result rather than filing it away. Everything here downloaded
    // as an unnamed binary, so a finished page could not be looked at: someone
    // who asked for a link to their site spent an afternoon being sent invented
    // URLs and third-party hosts while the built page sat in the project.
    if (req.nextUrl.searchParams.get("inline") === "1") {
      return new Response(content, {
        headers: {
          "Content-Disposition": `inline; filename="${fileName}"`,
          "Content-Type": inlineContentType(fileName),
          // The file is served from the same origin as the dashboard, and the
          // agent writes files out of pages it read on the internet, so its
          // markup cannot be trusted with this origin. The sandbox gives the
          // response an opaque origin: scripts still run, so a page with a
          // calculator on it still works, but nothing can reach the session,
          // cookies or storage of the workspace that produced it.
          "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

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
