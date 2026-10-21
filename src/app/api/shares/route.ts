import type { NextRequest } from "next/server";
import { fetchShares } from "@/lib/shares/client";
import { NO_STORE, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/** What colleagues shared with this workspace, and what it shared: GET /api/shares -> { mine, withMe }. */
export async function GET(req: NextRequest) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  try {
    return Response.json(await fetchShares(), { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
