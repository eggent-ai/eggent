import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { pageUrl } from "@/lib/files/page-token";
import { isHtmlName, scopeFile } from "@/lib/files/pages";

/**
 * Saving a file as a PDF - the browser's print dialog, opened in a tab of its own:
 *
 *   GET /api/files/page-print?project=<id|none>&path=<file>
 *
 * A page goes to a copy of itself that gets ready and prints; any other text
 * file to /print, which lays it out (Markdown as a document) and prints.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  const file = project && filePath ? await scopeFile(project, filePath) : null;
  if (!file) return Response.json({ error: "Not a file of this workspace." }, { status: 403 });
  const target = isHtmlName(file.relative)
    ? pageUrl(project, file.relative, "print")
    : `/print?${new URLSearchParams({ project, path: file.relative }).toString()}`;
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
