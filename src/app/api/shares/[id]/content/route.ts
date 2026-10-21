import type { NextRequest } from "next/server";
import { contentDisposition } from "@/lib/files/download-headers";
import { fetchSharedFile, writeSharedFile } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";
import { SHARE_MAX_WRITE_BYTES } from "@/lib/shares/types";

/**
 * A shared file's bytes, and a change to its text:
 *
 *   GET  /api/shares/<id>/content[?inline=1]   the file, to save or (inline) to look at
 *   POST /api/shares/<id>/content  { baseSha, text }  ->  { sha256, size }
 *
 * Opened inline it is sandboxed with no origin of its own, as this
 * workspace's own files are: a colleague's file is somebody else's markup.
 * A change is written into the owner's file only onto the version it was made
 * on (`baseSha`), and only by somebody it is shared with to edit - the
 * service decides that.
 */
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "text/plain", "text/markdown", "text/csv"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    const file = await fetchSharedFile(id);
    const inline = req.nextUrl.searchParams.get("inline") === "1" && INLINE_TYPES.has(file.mime);
    const headers: Record<string, string> = inline
      ? {
          "Content-Disposition": contentDisposition("inline", file.name),
          "Content-Type": file.mime.startsWith("text/") ? `${file.mime}; charset=utf-8` : file.mime,
          "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-modals",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        }
      : { "Content-Disposition": contentDisposition("attachment", file.name), "Content-Type": "application/octet-stream" };
    return new Response(new Uint8Array(file.data), { headers: { ...headers, "Content-Length": String(file.data.length), ...NO_STORE } });
  } catch (error) {
    return sharesFailure(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { baseSha?: unknown; text?: unknown } | null;
  if (typeof body?.baseSha !== "string" || !body.baseSha || typeof body.text !== "string") {
    return Response.json({ error: "The change is not well formed.", code: "badRequest" }, { status: 400, headers: NO_STORE });
  }
  const data = Buffer.from(body.text, "utf8");
  if (data.length > SHARE_MAX_WRITE_BYTES) {
    return Response.json({ error: "The text is too large to save here.", code: "fileTooLarge" }, { status: 413, headers: NO_STORE });
  }
  try {
    return Response.json(await writeSharedFile(id, { baseSha: body.baseSha, data }), { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
