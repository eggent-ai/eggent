import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { fetchApprovalFile } from "@/lib/approvals/client";
import { approvalIdOf, approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import { extractVersionText } from "@/lib/files/versions/text";

/**
 * The text of the version a round was sent with, for reading it here and for
 * seeing what changed since the round before:
 *
 *   GET /api/approvals/<id>/rounds/<n>/text  ->  { kind: "text" | "extracted" | "none", text, truncated? }
 *
 * A document is answered with the text read out of it, as in the file's history.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; round: string }> }) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const { id: rawId, round: rawRound } = await params;
  const id = approvalIdOf(rawId);
  const round = Number(rawRound);
  if (!id || !Number.isInteger(round) || round < 1) return Response.json({ error: "There is no such version.", code: "noRound" }, { status: 404, headers: NO_STORE });
  try {
    const file = await fetchApprovalFile(id, round);
    const extracted = await extractVersionText(file.name, file.data, { slide: t("files.history.slide") });
    return Response.json(
      { round, kind: extracted.kind, text: extracted.text, ...(extracted.truncated ? { truncated: true } : {}) },
      { headers: NO_STORE }
    );
  } catch (error) {
    return approvalsFailure(error);
  }
}
