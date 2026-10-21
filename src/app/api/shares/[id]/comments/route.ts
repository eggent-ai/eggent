import type { NextRequest } from "next/server";
import { addShareComment, fetchShareComments } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";
import { SHARE_MAX_QUOTE_CHARS, type ShareCommentAnchor } from "@/lib/shares/types";

/**
 * The comments on a shared file, and a new one in the person's name:
 *
 *   GET  /api/shares/<id>/comments  ->  { comments }
 *   POST /api/shares/<id>/comments  { body, quote?, anchor?, replyTo? }  ->  { comment }
 *
 * `quote` and `anchor` say which piece of the file a thread is about - the
 * block picked on a page, the lines chosen in its code.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json({ comments: await fetchShareComments(id) }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { body?: unknown; quote?: unknown; anchor?: unknown; replyTo?: unknown } | null;
  const text = typeof body?.body === "string" ? body.body : "";
  const replyTo = typeof body?.replyTo === "string" ? shareIdOf(body.replyTo) : null;
  const anchor = body?.anchor && typeof body.anchor === "object" ? (body.anchor as ShareCommentAnchor) : null;
  try {
    const comment = await addShareComment(id, {
      body: text,
      quote: typeof body?.quote === "string" ? body.quote.slice(0, SHARE_MAX_QUOTE_CHARS) : null,
      anchor,
      replyTo,
      author: "person",
    });
    return Response.json({ comment }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
