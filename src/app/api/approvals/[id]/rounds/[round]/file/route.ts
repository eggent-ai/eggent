import type { NextRequest } from "next/server";
import { fetchApprovalFile } from "@/lib/approvals/client";
import { approvalIdOf, approvalsFailure, approvalsGuard, NO_STORE } from "@/lib/approvals/route-helpers";
import { contentDisposition } from "@/lib/files/download-headers";

/**
 * The file a round was sent with, byte for byte - what was asked to be
 * approved, whatever the file in its author's workspace holds now:
 *
 *   GET /api/approvals/<id>/rounds/<n>/file[?inline=1]
 */
// What a browser may show rather than save. A colleague's document is not this
// workspace's to trust, so what is shown is sandboxed, as the Files panel does.
const INLINE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown", "text/csv"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; round: string }> }) {
  const refused = await approvalsGuard(req, { write: false });
  if (refused) return refused;
  const { id: rawId, round: rawRound } = await params;
  const id = approvalIdOf(rawId);
  const round = Number(rawRound);
  if (!id || !Number.isInteger(round) || round < 1) return Response.json({ error: "There is no such version.", code: "noRound" }, { status: 404, headers: NO_STORE });
  try {
    const file = await fetchApprovalFile(id, round);
    const inline = req.nextUrl.searchParams.get("inline") === "1" && INLINE.has(file.mime);
    const headers: Record<string, string> = inline
      ? {
          "Content-Disposition": contentDisposition("inline", file.name),
          "Content-Type": file.mime.startsWith("text/") ? `${file.mime}; charset=utf-8` : file.mime,
          "Content-Security-Policy": "sandbox allow-popups",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        }
      : { "Content-Disposition": contentDisposition("attachment", file.name), "Content-Type": "application/octet-stream" };
    return new Response(new Uint8Array(file.data), { headers: { ...headers, ...NO_STORE, "Content-Length": String(file.data.length) } });
  } catch (error) {
    return approvalsFailure(error);
  }
}
