import type { NextRequest } from "next/server";
import { fetchApproval } from "@/lib/approvals/client";
import { approvalIdOf, approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import { freshApproval } from "@/lib/approvals/status";

/** One approval, as this workspace may see it: GET /api/approvals/<id>. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  const id = approvalIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such approval.", code: "noApproval" }, { status: 404, headers: NO_STORE });
  try {
    // One's own file is looked at first: a changed file is never shown as on approval.
    return Response.json({ approval: await freshApproval(await fetchApproval(id)) }, { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
