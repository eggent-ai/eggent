import type { NextRequest } from "next/server";
import { ApprovalsServiceError, fetchApprovalCounts } from "@/lib/approvals/client";
import { approvalsEnabled } from "@/lib/approvals/config";
import { approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import type { ApprovalsSummary } from "@/lib/approvals/types";

/**
 * Whether this workspace has approvals at all, and what waits for it:
 *
 *   GET /api/approvals/summary  ->  { enabled: false } | { enabled: true, waiting, returned }
 *
 * A workspace the service says is in no company simply has no approvals.
 */
export async function GET(req: NextRequest) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  if (!approvalsEnabled()) return Response.json({ enabled: false } satisfies ApprovalsSummary, { headers: NO_STORE });
  try {
    const counts = await fetchApprovalCounts();
    return Response.json({ enabled: true, ...counts } satisfies ApprovalsSummary, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ApprovalsServiceError && error.code === "notInCompany") {
      return Response.json({ enabled: false } satisfies ApprovalsSummary, { headers: NO_STORE });
    }
    return approvalsFailure(error);
  }
}
