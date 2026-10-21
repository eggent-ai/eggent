import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { ApprovalsServiceError } from "@/lib/approvals/client";

/**
 * The checks every approvals route makes for itself: a signed-in session, a
 * request from this workspace's own pages, and JSON for a write. A decision is
 * made in the person's name, so a page on a sibling workspace - same site,
 * cookie and all - must not be able to make one (see terminal/guard.ts).
 */
export async function approvalsGuard(req: NextRequest, options: { write: boolean }): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, options);
  return failure ? jsonError(failure, guardStatus(failure)) : null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The service's own sentence and code, under the status it gave. */
export function approvalsFailure(error: unknown): Response {
  if (error instanceof ApprovalsServiceError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status >= 400 && error.status < 600 ? error.status : 502, headers: NO_STORE }
    );
  }
  console.error("[approvals]", error);
  return Response.json({ error: "Approvals are not available right now.", code: "failed" }, { status: 500, headers: NO_STORE });
}

/** An approval id as the service gives them; anything else is not one. */
export function approvalIdOf(raw: string): string | null {
  const id = decodeURIComponent(String(raw || "")).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}
