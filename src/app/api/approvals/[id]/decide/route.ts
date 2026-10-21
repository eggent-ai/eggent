import type { NextRequest } from "next/server";
import { decideOnApproval } from "@/lib/approvals/client";
import { approvalIdOf, approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";

/**
 * The person's decision on the version whose turn is theirs:
 *
 *   POST /api/approvals/<id>/decide  { round, decision: "approve" | "reject", comment? }  ->  { approval }
 *
 * Always the person's: the agent has no way to decide (lib/approvals/tool.ts).
 * `round` is the one on the screen, so a decision about a version that has
 * since been replaced is refused rather than given to the new one.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await approvalsGuard(req, { write: true });
  if (refused) return refused;
  const id = approvalIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such approval.", code: "noApproval" }, { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { round?: unknown; decision?: unknown; comment?: unknown } | null;
  const decision = body?.decision === "approve" || body?.decision === "reject" ? body.decision : null;
  const round = Number(body?.round);
  if (!decision || !Number.isInteger(round) || round < 1) {
    return Response.json({ error: "A decision needs the round and approve or reject.", code: "badRequest" }, { status: 400, headers: NO_STORE });
  }
  try {
    const approval = await decideOnApproval(id, { round, decision, comment: typeof body?.comment === "string" ? body.comment : "", author: "person" });
    return Response.json({ approval }, { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
