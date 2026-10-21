import type { NextRequest } from "next/server";
import { fetchShare, stopSharingFile } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";
import { watchSharedKey } from "@/lib/shares/watch";

/** The owner stops sharing a file: its people lose it and its comments go. POST /api/shares/<id>/stop. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    const { share } = await fetchShare(id);
    await stopSharingFile(id);
    if (share.fileKey) watchSharedKey(share.fileKey, false);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
