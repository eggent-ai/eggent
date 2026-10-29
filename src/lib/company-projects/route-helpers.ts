import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { CompanyProjectsError } from "@/lib/company-projects/client";

/**
 * The checks every company-project route makes for itself: a signed-in
 * session, a request from this workspace's own pages, and JSON for a write. A
 * question is asked in the person's name, so a page on a sibling workspace -
 * same site, cookie and all - must not be able to ask one (see terminal/guard.ts).
 */
export async function companyProjectsGuard(req: NextRequest, options: { write: boolean }): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, options);
  return failure ? jsonError(failure, guardStatus(failure)) : null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function companyProjectsFailure(error: unknown): Response {
  if (error instanceof CompanyProjectsError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status >= 400 && error.status < 600 ? error.status : 502, headers: NO_STORE }
    );
  }
  console.error("[company-projects]", error);
  return Response.json({ error: "Company projects are not available right now.", code: "failed" }, { status: 500, headers: NO_STORE });
}

/** A project id as the service gives them; anything else is not one. */
export function companyProjectIdOf(raw: string): string | null {
  let id = "";
  try {
    id = decodeURIComponent(String(raw || "")).trim();
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
}
