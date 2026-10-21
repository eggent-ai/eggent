import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { contentDisposition } from "@/lib/files/download-headers";
import { markForEditing, readPage } from "@/lib/files/html-source";
import { readPageToken } from "@/lib/files/page-token";
import { editingScript, PRINT_STYLE, printScript } from "@/lib/files/page-scripts";
import { isHtmlName, MAX_PAGE_BYTES, pageContentType, readScopeFile, scopeFile, sourceSha } from "@/lib/files/pages";
import { openPlainFile } from "@/lib/files/safe-open";

/**
 * A page of this workspace, and the files beside it, for the frame on screen:
 *
 *   GET /api/files/page/<token>/<path>[?eggent=edit|print]
 *
 * No session is asked for - a sandboxed frame sends none - the token is the
 * credential (lib/files/page-token.ts): it names one scope and expires. Every
 * answer is sandboxed with no origin of its own, may not fetch anything, and
 * sends no referrer, so a page's scripts can neither reach the workspace nor
 * read its files and carry them off; the token never leaves in a Referer.
 *
 * `edit` serves a copy marked for pointing at blocks, with the page's own
 * scripts off; `print` a copy that gets ready and opens the print dialog.
 */

function notFound(): Response {
  return new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function policy(mode: "view" | "edit" | "print", nonce: string): string {
  const sandbox = mode === "edit" ? "sandbox allow-scripts" : "sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox";
  const scripts = mode === "edit" ? `; script-src 'nonce-${nonce}'` : "";
  return `${sandbox}; connect-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'${scripts}`;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; path: string[] }> }) {
  const { token, path: segments } = await params;
  const scope = readPageToken(token);
  if (!scope) {
    return new Response("This link has expired. Open the page again.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const file = await scopeFile(scope.project, (segments || []).map((segment) => decodeURIComponent(segment)).join("/"));
  if (!file) return notFound();
  const requested = req.nextUrl.searchParams.get("eggent");
  const html = isHtmlName(file.relative);
  const mode: "view" | "edit" | "print" = html && (requested === "edit" || requested === "print") ? requested : "view";
  const nonce = randomBytes(16).toString("base64");
  const headers: Record<string, string> = {
    "Content-Type": pageContentType(file.relative),
    "Content-Disposition": contentDisposition("inline", file.relative.split("/").pop() || "file"),
    "Content-Security-Policy": policy(mode, nonce),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };

  if (mode !== "view") {
    const bytes = await readScopeFile(file, MAX_PAGE_BYTES);
    if (!Buffer.isBuffer(bytes)) return notFound();
    const source = bytes.toString("utf8");
    let body: string;
    if (mode === "edit") {
      body = markForEditing(source, readPage(source), editingScript(sourceSha(source), nonce));
    } else {
      const title = (file.relative.split("/").pop() || "page").replace(/\.html?$/i, "");
      const page = readPage(source);
      body = markForEditing(source, { elements: [], bodyEnd: page.bodyEnd }, `${PRINT_STYLE}${printScript(title)}`);
    }
    return new Response(body, { headers });
  }

  // Streamed from the very handle that was checked: nothing can be swapped in between.
  const handle = await openPlainFile(file.absolute, { root: file.root });
  if (!handle) return notFound();
  const size = (await handle.stat()).size;
  headers["Content-Length"] = String(size);
  if (size === 0) {
    await handle.close().catch(() => undefined);
    return new Response(null, { headers });
  }
  const stream = Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { headers });
}
