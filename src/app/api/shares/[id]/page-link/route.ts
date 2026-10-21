import type { NextRequest } from "next/server";
import { sharePageUrl } from "@/lib/files/page-token";
import { isHtmlName } from "@/lib/files/pages";
import { fetchShare } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";
import { canComment, canEdit } from "@/lib/shares/types";

/**
 * Where a shared page is shown on screen, for a while:
 *
 *   GET /api/shares/<id>/page-link[?mode=edit|print]  ->  { url }
 *
 * `edit` asks for the page marked for pointing at blocks: with words that can
 * be changed for somebody it is shared with to edit, for pointing only for
 * somebody who may comment, and not at all for somebody who may only look.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    const { share } = await fetchShare(id);
    if (!isHtmlName(share.fileName)) return Response.json({ error: "Only a page is shown this way.", code: "notPage" }, { status: 400, headers: NO_STORE });
    const requested = req.nextUrl.searchParams.get("mode");
    const mode = requested === "print" ? "print" : requested === "edit" ? (canEdit(share.myRole) ? "edit" : canComment(share.myRole) ? "pick" : undefined) : undefined;
    return Response.json({ url: sharePageUrl(id, share.fileName, mode) }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
