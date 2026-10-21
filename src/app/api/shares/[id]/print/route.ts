import type { NextRequest } from "next/server";
import { sharePageUrl } from "@/lib/files/page-token";
import { isHtmlName } from "@/lib/files/pages";
import { fetchShare } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/**
 * A shared file made ready to be saved as a PDF: GET /api/shares/<id>/print.
 * A page goes to its printing copy, any other text to the print view.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    const { share } = await fetchShare(id);
    const target = isHtmlName(share.fileName) ? sharePageUrl(id, share.fileName, "print") : `/print?${new URLSearchParams({ share: id }).toString()}`;
    return new Response(null, { status: 302, headers: { Location: target, ...NO_STORE } });
  } catch (error) {
    return sharesFailure(error);
  }
}
