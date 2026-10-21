import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { SharesServiceError } from "@/lib/shares/client";

/**
 * The checks every sharing route makes for itself: a signed-in session, a
 * request from this workspace's own pages, and JSON for a write. A share, a
 * comment and a change to a colleague's file are made in the person's name, so
 * a page on a sibling workspace - same site, cookie and all - must not be able
 * to make one (see terminal/guard.ts).
 */
export async function sharesGuard(req: NextRequest, options: { write: boolean }): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, options);
  return failure ? jsonError(failure, guardStatus(failure)) : null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The service's own sentence and code, under the status it gave. */
export function sharesFailure(error: unknown): Response {
  if (error instanceof SharesServiceError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status >= 400 && error.status < 600 ? error.status : 502, headers: NO_STORE }
    );
  }
  console.error("[shares]", error);
  return Response.json({ error: "Sharing is not available right now.", code: "failed" }, { status: 500, headers: NO_STORE });
}

/** A share or comment id as the service gives them; anything else is not one. */
export function shareIdOf(raw: string): string | null {
  let id = "";
  try {
    id = decodeURIComponent(String(raw || "")).trim();
  } catch {
    return null;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}
