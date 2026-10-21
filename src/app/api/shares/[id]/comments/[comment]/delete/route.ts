import type { NextRequest } from "next/server";
import { deleteShareComment } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/** A comment deleted by its author or the file's owner: POST /api/shares/<id>/comments/<comment>/delete. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; comment: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const { id: rawId, comment: rawComment } = await params;
  const id = shareIdOf(rawId);
  const comment = shareIdOf(rawComment);
  if (!id || !comment) return Response.json({ error: "There is no such comment.", code: "noComment" }, { status: 404, headers: NO_STORE });
  try {
    await deleteShareComment(id, comment);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
