import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { readSharePageToken } from "@/lib/files/page-token";
import { pageCopy, pageHeaders, pageLinkExpired, pageModeOf, pageNotFound } from "@/lib/files/page-serve";
import { isHtmlName, MAX_PAGE_BYTES } from "@/lib/files/pages";
import { fetchSharedAsset, fetchSharedFile, SharesServiceError } from "@/lib/shares/client";

/**
 * A page a colleague shared, and the files beside it, for the frame on screen:
 *
 *   GET /api/shares/page/<token>/<page file name>[?eggent=edit|pick|print]
 *   GET /api/shares/page/<token>/<path beside it>
 *
 * The token names the share and the page (page-token.ts); what the page and
 * its pictures are is the sharing service's answer, read from the owner's
 * workspace - which serves only the page's own folder and below it, never a
 * link or a credential. Sandboxed like this workspace's own pages
 * (page-serve.ts).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; path: string[] }> }) {
  const { token, path: segments } = await params;
  const scope = readSharePageToken(token);
  if (!scope) return pageLinkExpired();
  let relative = "";
  try {
    relative = (segments || []).map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return pageNotFound();
  }
  if (!relative) return pageNotFound();
  const nonce = randomBytes(16).toString("base64");
  try {
    if (relative === scope.fileName) {
      const mode = pageModeOf(req.nextUrl.searchParams.get("eggent"), isHtmlName(scope.fileName));
      const file = await fetchSharedFile(scope.share);
      const headers = pageHeaders(scope.fileName, mode, nonce);
      if (mode !== "view") {
        if (file.data.length > MAX_PAGE_BYTES) return pageNotFound();
        return new Response(pageCopy(file.data.toString("utf8"), mode, nonce, scope.fileName), { headers });
      }
      headers["Content-Length"] = String(file.data.length);
      return new Response(new Uint8Array(file.data), { headers });
    }
    const asset = await fetchSharedAsset(scope.share, relative);
    const headers = pageHeaders(relative, "view", nonce);
    headers["Content-Length"] = String(asset.data.length);
    return new Response(new Uint8Array(asset.data), { headers });
  } catch (error) {
    if (error instanceof SharesServiceError && error.status >= 400 && error.status < 500) return pageNotFound();
    return new Response("The page could not be read just now.", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
