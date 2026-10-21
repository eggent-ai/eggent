import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import { fileApprovalStatus } from "@/lib/approvals/status";

/**
 * One file of this workspace and its approval:
 *
 *   GET /api/approvals/file?project=<id|none>&path=<file>  ->  FileApprovalStatus
 *
 * Looking is enough to void a round whose file has changed (status.ts).
 */
export async function GET(req: NextRequest) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  if (!project || !filePath) return Response.json({ error: t("api.error.projectIdAndFilePathRequired") }, { status: 400, headers: NO_STORE });
  try {
    const answer = await fileApprovalStatus(project, filePath);
    if ("error" in answer) return Response.json({ error: t("api.error.invalidFilePath"), code: "outside" }, { status: 403, headers: NO_STORE });
    return Response.json(answer.status, { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
