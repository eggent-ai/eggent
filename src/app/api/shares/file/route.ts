import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { fileShareStatus } from "@/lib/shares/files";
import { NO_STORE, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/**
 * One file of this workspace and who it is shared with:
 *
 *   GET /api/shares/file?project=<id|none>&path=<file>  ->  FileShareStatus
 */
export async function GET(req: NextRequest) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  if (!project || !filePath) return Response.json({ error: t("api.error.projectIdAndFilePathRequired") }, { status: 400, headers: NO_STORE });
  try {
    const answer = await fileShareStatus(project, filePath);
    if ("error" in answer) return Response.json({ error: t("api.error.invalidFilePath"), code: "outside" }, { status: 403, headers: NO_STORE });
    return Response.json(answer.status, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
