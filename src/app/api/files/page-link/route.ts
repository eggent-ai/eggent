import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { pageUrl } from "@/lib/files/page-token";
import { isHtmlName, scopeFile } from "@/lib/files/pages";

/**
 * Where a page of this workspace is shown on screen, for the person who asks:
 *
 *   GET /api/files/page-link?project=<id|none>&path=<file>[&mode=edit|print]  ->  { url }
 *
 * The address carries a token that lets a sandboxed frame load the page and
 * the files beside it for half an hour (lib/files/page-token.ts).
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  const mode = req.nextUrl.searchParams.get("mode");
  const file = project && filePath ? await scopeFile(project, filePath) : null;
  if (!file) return Response.json({ error: "Not a file of this workspace.", code: "outside" }, { status: 403 });
  const wanted = mode === "edit" || mode === "print" ? mode : undefined;
  if (wanted && !isHtmlName(file.relative)) return Response.json({ error: "Only a page can be shown this way.", code: "notPage" }, { status: 400 });
  return Response.json({ url: pageUrl(project, file.relative, wanted) }, { headers: { "Cache-Control": "no-store" } });
}
