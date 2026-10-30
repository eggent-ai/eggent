import type { NextRequest } from "next/server";
import { companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";
import { getProjectSharingConfig } from "@/lib/project-sharing/config";
import { cleanProjectSharing, type ProjectSharingAnswer } from "@/lib/project-sharing/types";

/**
 * Which of this workspace's projects are shared, for the marks beside them in
 * the sidebar:
 *
 *   GET /api/project-sharing  ->  { enabled: false } | { enabled: true, projects }
 *
 * Asked on the same load as the project list, so it has to answer fast: a
 * service that is slow or away answers like nothing is shared.
 */
const CALL_TIMEOUT_MS = 4000;

export async function GET(req: NextRequest) {
  const config = getProjectSharingConfig();
  // Nothing to say and nothing to protect: answered before the session check,
  // so a workspace without the service never makes the sidebar wait on it.
  if (!config) return Response.json({ enabled: false } satisfies ProjectSharingAnswer, { headers: NO_STORE });
  const refused = await companyProjectsGuard(req, { write: false });
  if (refused) return refused;
  try {
    const response = await fetch(config.url, {
      headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return Response.json({ enabled: true, projects: cleanProjectSharing(await response.json()) } satisfies ProjectSharingAnswer, { headers: NO_STORE });
  } catch (error) {
    console.warn(`[project-sharing] ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ enabled: true, projects: {} } satisfies ProjectSharingAnswer, { headers: NO_STORE });
  }
}
