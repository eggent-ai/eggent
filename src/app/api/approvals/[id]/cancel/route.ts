import type { NextRequest } from "next/server";
import { cancelApprovalRequest } from "@/lib/approvals/client";
import { approvalIdOf, approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import { watchApproval } from "@/lib/approvals/watch";

/** The author takes a version off approval: POST /api/approvals/<id>/cancel. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await approvalsGuard(req, { write: true });
  if (refused) return refused;
  const id = approvalIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such approval.", code: "noApproval" }, { status: 404, headers: NO_STORE });
  try {
    const approval = await cancelApprovalRequest(id);
    watchApproval(approval);
    return Response.json({ approval }, { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
