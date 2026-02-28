import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");

  if (!filePath) {
    return Response.json({ error: "path parameter required" }, { status: 400 });
  }

  // Security: only allow image extensions
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return Response.json({ error: "Only image files are allowed" }, { status: 403 });
  }

  // Security: resolve and ensure the file is within the data directory
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(DATA_DIR + path.sep) && !resolved.startsWith(DATA_DIR)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return Response.json({ error: "Not a file" }, { status: 404 });
    }

    const content = await fs.readFile(resolved);
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";

    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(stat.size),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}
