import type { NextRequest } from "next/server";
import { absoluteInScope, keyOfFile } from "@/lib/files/project-keys";
import { fetchShareEdits, SharesServiceError } from "@/lib/shares/client";
import { sharesEnabled } from "@/lib/shares/config";
import { NO_STORE, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/**
 * Who changed one of this workspace's files through a share, for its history:
 *
 *   GET /api/shares/edits?project=<id|none>&path=<file>  ->  { edits: [{ sha256, by, at }] }
 *
 * A version of the file whose content is one of these was written by that
 * colleague; the history itself only saw it change from outside.
 */
export async function GET(req: NextRequest) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  if (!sharesEnabled()) return Response.json({ edits: [] }, { headers: NO_STORE });
  const project = req.nextUrl.searchParams.get("project")?.trim() || "";
  const filePath = req.nextUrl.searchParams.get("path")?.trim() || "";
  const absolute = project && filePath ? absoluteInScope(project, filePath) : null;
  const key = absolute ? await keyOfFile(absolute) : null;
  if (!key) return Response.json({ edits: [] }, { headers: NO_STORE });
  try {
    return Response.json({ edits: await fetchShareEdits(key) }, { headers: NO_STORE });
  } catch (error) {
    // A file the service refuses to name (not in a company, a credential) has no colleague's changes in its history.
    if (error instanceof SharesServiceError && error.status < 500) return Response.json({ edits: [] }, { headers: NO_STORE });
    return sharesFailure(error);
  }
}
