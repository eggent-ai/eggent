import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerTranslator } from "@/i18n/server";
import { versionTargetFor } from "@/lib/files/versions/capture";
import { getVersionStore } from "@/lib/files/versions/store";
import { historyOf } from "@/lib/files/versions/view";

/**
 * A file's history.
 *
 *   GET    /api/files/versions?project=<id|none>&path=<file>  ->  FileHistoryView
 *   DELETE /api/files/versions?project=<id|none>&path=<file>  ->  { removed }
 *
 * Each handler checks the session itself rather than trusting the middleware in
 * front of it (open issue 2), and from this site only: a history holds every
 * version of a document, including the text somebody since took out of it.
 */

function fileOf(req: NextRequest): { project: string; path: string } | null {
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  return project && filePath ? { project, path: filePath } : null;
}

export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const file = fileOf(req);
  if (!file) return jsonError(t("api.error.projectIdAndFilePathRequired"), 400);
  const { view } = await historyOf(file.project, file.path);
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  // A DELETE is never a request a foreign page can make without asking first, so no body is needed to tell.
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const file = fileOf(req);
  if (!file) return jsonError(t("api.error.projectIdAndFilePathRequired"), 400);
  const target = await versionTargetFor(file.project, file.path);
  if (!target) return jsonError(t("api.error.invalidFilePath"), 403);
  const removed = await getVersionStore().forget(target.key);
  return Response.json({ removed }, { headers: { "Cache-Control": "no-store" } });
}
