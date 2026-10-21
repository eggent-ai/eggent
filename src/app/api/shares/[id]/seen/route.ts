import type { NextRequest } from "next/server";
import { markShareSeen } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/** The person opened a file shared with them: what was new is not any more. POST /api/shares/<id>/seen. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    await markShareSeen(id);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
