import path from "node:path";
import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerTranslator } from "@/i18n/server";
import { contentDisposition } from "@/lib/files/download-headers";
import { versionTargetFor } from "@/lib/files/versions/capture";
import { getVersionStore } from "@/lib/files/versions/store";

/**
 * One version as a file, named after the file and the version:
 *
 *   GET /api/files/versions/download?project=<id|none>&path=<file>&n=<version>
 *
 * Always an attachment and never shown inline: an old version of a page the
 * agent built must not run with the dashboard's origin either.
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
  const content = await getVersionStore().content(target.key, n);
  if (!content) return jsonError(t("files.history.versionMissing"), 404);
  const extension = path.extname(target.name);
  const stem = extension ? target.name.slice(0, -extension.length) : target.name;
  return new Response(new Uint8Array(content), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.length),
      "Content-Disposition": contentDisposition("attachment", `${stem} (v${n})${extension}`),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
