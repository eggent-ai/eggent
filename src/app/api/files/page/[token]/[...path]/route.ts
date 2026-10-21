import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { readPageToken } from "@/lib/files/page-token";
import { pageCopy, pageHeaders, pageLinkExpired, pageModeOf, pageNotFound } from "@/lib/files/page-serve";
import { isHtmlName, MAX_PAGE_BYTES, readScopeFile, scopeFile } from "@/lib/files/pages";
import { openPlainFile } from "@/lib/files/safe-open";

/**
 * A page of this workspace, and the files beside it, for the frame on screen:
 *
 *   GET /api/files/page/<token>/<path>[?eggent=edit|pick|print]
 *
 * No session is asked for - a sandboxed frame sends none - the token is the
 * credential (lib/files/page-token.ts): it names one scope and expires. How
 * the answer is sandboxed is page-serve.ts.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; path: string[] }> }) {
  const { token, path: segments } = await params;
  const scope = readPageToken(token);
  if (!scope) return pageLinkExpired();
  const file = await scopeFile(scope.project, (segments || []).map((segment) => decodeURIComponent(segment)).join("/"));
  if (!file) return pageNotFound();
  const mode = pageModeOf(req.nextUrl.searchParams.get("eggent"), isHtmlName(file.relative));
  const nonce = randomBytes(16).toString("base64");
  const headers = pageHeaders(file.relative, mode, nonce);

  if (mode !== "view") {
    const bytes = await readScopeFile(file, MAX_PAGE_BYTES);
    if (!Buffer.isBuffer(bytes)) return pageNotFound();
    return new Response(pageCopy(bytes.toString("utf8"), mode, nonce, file.relative), { headers });
  }

  // Streamed from the very handle that was checked: nothing can be swapped in between.
  const handle = await openPlainFile(file.absolute, { root: file.root });
  if (!handle) return pageNotFound();
  const size = (await handle.stat()).size;
  headers["Content-Length"] = String(size);
  if (size === 0) {
    await handle.close().catch(() => undefined);
    return new Response(null, { headers });
  }
  const stream = Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { headers });
}
