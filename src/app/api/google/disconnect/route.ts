import type { NextRequest } from "next/server";
import { disconnectGoogle, fetchGoogleStatus } from "@/lib/google/client";
import { googleEnabled } from "@/lib/google/config";
import { googleFailure, googleGuard, NO_STORE } from "@/lib/google/route-helpers";

/**
 * The person disconnects Google from Settings:
 *
 *   POST /api/google/disconnect  ->  { enabled: true, connected: false, ... }
 *
 * The service revokes the grant at Google, so the files stay in the person's
 * Drive and nothing here can reach them any more.
 */
export async function POST(req: NextRequest) {
  const refused = await googleGuard(req, { write: true });
  if (refused) return refused;
  if (!googleEnabled()) return Response.json({ enabled: false }, { status: 404, headers: NO_STORE });
  try {
    await disconnectGoogle();
    return Response.json({ enabled: true, ...(await fetchGoogleStatus()) }, { headers: NO_STORE });
  } catch (error) {
    return googleFailure(error);
  }
}
