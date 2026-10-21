import type { NextRequest } from "next/server";
import { resolveShareComment } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/** A thread marked resolved, or open again: POST /api/shares/<id>/comments/<comment>/resolve { resolved }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; comment: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const { id: rawId, comment: rawComment } = await params;
  const id = shareIdOf(rawId);
  const comment = shareIdOf(rawComment);
  if (!id || !comment) return Response.json({ error: "There is no such comment.", code: "noComment" }, { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { resolved?: unknown } | null;
  try {
    return Response.json({ comment: await resolveShareComment(id, comment, body?.resolved !== false) }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
