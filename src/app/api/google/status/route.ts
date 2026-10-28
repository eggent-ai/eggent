import type { NextRequest } from "next/server";
import { fetchGoogleStatus } from "@/lib/google/client";
import { googleEnabled } from "@/lib/google/config";
import { googleFailure, googleGuard, NO_STORE } from "@/lib/google/route-helpers";

/**
 * Whether this workspace can reach Google, and as whom:
 *
 *   GET /api/google/status  ->  { enabled: false } | { enabled: true, connected, email?, sheets, calendar, connectUrl }
 *
 * `enabled: false` means the deployment offers no Google at all, and nothing
 * about it is shown.
 */
export async function GET(req: NextRequest) {
  const refused = await googleGuard(req, { write: false });
  if (refused) return refused;
  if (!googleEnabled()) return Response.json({ enabled: false }, { headers: NO_STORE });
  try {
    return Response.json({ enabled: true, ...(await fetchGoogleStatus()) }, { headers: NO_STORE });
  } catch (error) {
    return googleFailure(error);
  }
}
