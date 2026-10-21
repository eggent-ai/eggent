import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { absoluteInScope } from "@/lib/approvals/files";
import { sendFileForApproval, type SendFailure } from "@/lib/approvals/outgoing";
import { approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import { APPROVAL_MAX_FILE_BYTES } from "@/lib/approvals/types";

/**
 * Sends a file of this workspace for approval, as it is this moment:
 *
 *   POST /api/approvals/send  { project, path, approvers: [id, ...], note? }  ->  { approval }
 *
 * The person's own send, from the file's screen; the chain goes in the order given.
 */
const STATUS: Record<SendFailure, number> = { outside: 403, missing: 404, notFile: 400, sensitive: 400, tooLarge: 413, empty: 400 };

export async function POST(req: NextRequest) {
  const refused = await approvalsGuard(req, { write: true });
  if (refused) return refused;
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { project?: unknown; path?: unknown; approvers?: unknown; note?: unknown } | null;
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const filePath = typeof body?.path === "string" ? body.path.trim() : "";
  const approvers = Array.isArray(body?.approvers) ? body.approvers.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
  if (!project || !filePath) return Response.json({ error: t("api.error.projectIdAndFilePathRequired") }, { status: 400, headers: NO_STORE });
  if (!approvers.length) return Response.json({ error: t("approvals.error.noApprovers"), code: "emptyChain" }, { status: 400, headers: NO_STORE });
  const absolute = absoluteInScope(project, filePath);
  if (!absolute) return Response.json({ error: t("approvals.error.outside"), code: "outside" }, { status: 403, headers: NO_STORE });
  try {
    const sent = await sendFileForApproval({ absolute, approvers, note: typeof body?.note === "string" ? body.note : "", author: "person" });
    if ("error" in sent) {
      const message = t(`approvals.error.${sent.error}`, { maxMb: APPROVAL_MAX_FILE_BYTES / 1024 / 1024 });
      return Response.json({ error: message, code: sent.error }, { status: STATUS[sent.error], headers: NO_STORE });
    }
    return Response.json({ approval: sent.approval }, { headers: NO_STORE });
  } catch (error) {
    return approvalsFailure(error);
  }
}
