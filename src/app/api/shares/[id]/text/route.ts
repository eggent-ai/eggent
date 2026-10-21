import type { NextRequest } from "next/server";
import { readSharedContent } from "@/lib/shares/content";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/**
 * A shared file as its screen shows it:
 *
 *   GET /api/shares/<id>/text  ->  { kind: "text" | "extracted" | "image" | "binary", text?, name, mime, size, sha256 }
 *
 * `sha256` is what a change made from this screen is made on.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json(await readSharedContent(id), { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
