import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerTranslator } from "@/i18n/server";
import { versionTargetFor } from "@/lib/files/versions/capture";
import { versionText } from "@/lib/files/versions/view";

/**
 * The text of one version, for showing and comparing:
 *
 *   GET /api/files/versions/content?project=<id|none>&path=<file>&n=<version>  ->  VersionTextView
 *
 * A document is answered with the text read out of it (`kind: "extracted"`).
 */

export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  const n = Number(req.nextUrl.searchParams.get("n"));
  if (!project || !filePath || !Number.isInteger(n) || n < 1) return jsonError(t("api.error.projectIdAndFilePathRequired"), 400);
  const target = await versionTargetFor(project, filePath);
  if (!target) return jsonError(t("api.error.invalidFilePath"), 403);
  const view = await versionText(target, n, { slide: t("files.history.slide") });
  if (!view) return jsonError(t("files.history.versionMissing"), 404);
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
