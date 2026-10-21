import type { NextRequest } from "next/server";
import { fetchShareCounts, SharesServiceError } from "@/lib/shares/client";
import { sharesEnabled } from "@/lib/shares/config";
import { NO_STORE, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";
import type { SharesSummary } from "@/lib/shares/types";

/**
 * Whether this workspace shares files at all, and what is new for its person:
 *
 *   GET /api/shares/summary  ->  { enabled: false } | { enabled: true, withMe, unseen, openOnMine }
 *
 * A workspace the service says is in no company simply has no sharing.
 */
export async function GET(req: NextRequest) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  if (!sharesEnabled()) return Response.json({ enabled: false } satisfies SharesSummary, { headers: NO_STORE });
  try {
    const counts = await fetchShareCounts();
    return Response.json({ enabled: true, ...counts } satisfies SharesSummary, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SharesServiceError && error.code === "notInCompany") {
      return Response.json({ enabled: false } satisfies SharesSummary, { headers: NO_STORE });
    }
    return sharesFailure(error);
  }
}
