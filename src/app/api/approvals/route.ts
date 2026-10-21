import type { NextRequest } from "next/server";
import { fetchApprovals } from "@/lib/approvals/client";
import { approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import type { ApprovalBox } from "@/lib/approvals/types";

/**
 * One box of approvals:
 *
 *   GET /api/approvals?box=waiting|sent|involved  ->  { approvals, counts }
 *
 * `waiting` is what waits for this person's decision, `sent` what they sent,
 * `involved` what they were asked about by others.
 */
const BOXES = new Set<ApprovalBox>(["waiting", "sent", "involved"]);

export async function GET(req: NextRequest) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  const raw = req.nextUrl.searchParams.get("box") as ApprovalBox | null;
  const box: ApprovalBox = raw && BOXES.has(raw) ? raw : "waiting";
  try {
    return Response.json(await fetchApprovals(box, 100), { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
