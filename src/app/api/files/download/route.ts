import type { NextRequest } from "next/server";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { getWorkDir } from "@/lib/storage/project-store";
import { getServerTranslator } from "@/i18n/server";
import { audioContentType } from "@/lib/files/openable";
import { contentDisposition, parseByteRange } from "@/lib/files/download-headers";

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
  return (
    INLINE_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ||
    audioContentType(fileName) ||
    "text/plain; charset=utf-8"
  );
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

  const resolvedWorkDir = path.resolve(getWorkDir(projectId));
  const resolvedPath = path.resolve(path.join(resolvedWorkDir, filePath));

  // Security check. A bare prefix test also let through a sibling whose name
  // starts with this directory's - `../projects.json` from `projects`.
  if (resolvedPath !== resolvedWorkDir && !resolvedPath.startsWith(resolvedWorkDir + path.sep)) {
    return Response.json(
      { error: t("api.error.invalidFilePath") },
      { status: 403 }
    );
  }

  let size: number;
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) throw new Error("Not a file");
    size = stat.size;
  } catch {
    return Response.json({ error: t("api.error.fileNotFound") }, { status: 404 });
  }

  const fileName = path.basename(filePath);

  // Opening a result rather than filing it away. Everything here downloaded
  // as an unnamed binary, so a finished page could not be looked at: someone
  // who asked for a link to their site spent an afternoon being sent invented
  // URLs and third-party hosts while the built page sat in the project.
  const headers: Record<string, string> =
    req.nextUrl.searchParams.get("inline") === "1"
      ? {
          "Content-Disposition": contentDisposition("inline", fileName),
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
        }
      : {
          "Content-Disposition": contentDisposition("attachment", fileName),
          "Content-Type": "application/octet-stream",
        };
  headers["Accept-Ranges"] = "bytes";

  // An audio element reads a file in pieces, and Safari will not play one at
  // all from a server that answers a piece with the whole file.
  const range = parseByteRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers["Content-Length"] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

  // Streamed rather than read whole: a player asks for `bytes=0-` of a long
  // recording and then for piece after piece as it seeks.
  const body =
    size === 0
      ? null
      : (Readable.toWeb(createReadStream(resolvedPath, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}
