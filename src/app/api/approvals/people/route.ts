import type { NextRequest } from "next/server";
import { fetchApprovalPeople } from "@/lib/approvals/client";
import { approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";

/** Everybody in the company a version can be sent to: GET /api/approvals/people. */
export async function GET(req: NextRequest) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  try {
    return Response.json(await fetchApprovalPeople(), { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
