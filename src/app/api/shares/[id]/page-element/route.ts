import type { NextRequest } from "next/server";
import { blockOf } from "@/lib/files/page-blocks";
import { MAX_PAGE_BYTES, sourceSha } from "@/lib/files/pages";
import { fetchSharedFile } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/**
 * A block picked on a shared page, as it is in the file:
 *
 *   GET /api/shares/<id>/page-element?sha=<hash>&el=<n>  ->  { label, startLine, endLine, start, end, source }
 *
 * 409 when the file changed since the page on screen was made from it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    const file = await fetchSharedFile(id);
    if (file.data.length > MAX_PAGE_BYTES) return Response.json({ error: "The page is too large to point at.", code: "tooLarge" }, { status: 413, headers: NO_STORE });
    const source = file.data.toString("utf8");
    if (sourceSha(source) !== req.nextUrl.searchParams.get("sha")) {
      return Response.json({ error: "The file has changed since the page was shown.", code: "changed" }, { status: 409, headers: NO_STORE });
    }
    const block = blockOf(source, Number(req.nextUrl.searchParams.get("el")));
    if (!block) return Response.json({ error: "No such block.", code: "noElement" }, { status: 404, headers: NO_STORE });
    return Response.json(block, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
