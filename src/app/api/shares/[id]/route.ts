import type { NextRequest } from "next/server";
import { fetchShare } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/** One shared file as its people see it: GET /api/shares/<id> -> { share, file }. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json(await fetchShare(id), { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
