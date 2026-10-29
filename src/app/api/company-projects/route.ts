import type { NextRequest } from "next/server";
import { CompanyProjectsError, fetchCompanyProjects } from "@/lib/company-projects/client";
import { companyProjectsEnabled } from "@/lib/company-projects/config";
import { companyProjectsFailure, companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";
import type { CompanyProjectsList } from "@/lib/company-projects/types";

/**
 * The projects this person's company opened to them:
 *
 *   GET /api/company-projects  ->  { enabled: false } | { enabled: true, projects }
 */
export async function GET(req: NextRequest) {
  const refused = await companyProjectsGuard(req, { write: false });
  if (refused) return refused;
  if (!companyProjectsEnabled()) return Response.json({ enabled: false } satisfies CompanyProjectsList, { headers: NO_STORE });
  try {
    return Response.json({ enabled: true, projects: await fetchCompanyProjects() } satisfies CompanyProjectsList, { headers: NO_STORE });
  } catch (error) {
    // A service that is not there answers like no projects, not like a broken sidebar.
    if (error instanceof CompanyProjectsError && (error.code === "unreachable" || error.status === 503)) {
      return Response.json({ enabled: true, projects: [] } satisfies CompanyProjectsList, { headers: NO_STORE });
    }
    return companyProjectsFailure(error);
  }
}
