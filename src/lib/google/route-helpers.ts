import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { GoogleServiceError } from "@/lib/google/client";

/**
 * The checks every Google route makes for itself: a signed-in session, a
 * request from this workspace's own pages, and JSON for a write. Disconnecting
 * acts on the person's account, so a page on a sibling workspace - same site,
 * cookie and all - must not be able to do it (see terminal/guard.ts).
 */
export async function googleGuard(req: NextRequest, options: { write: boolean }): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, options);
  return failure ? jsonError(failure, guardStatus(failure)) : null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The service's own sentence and code, under the status it gave. */
export function googleFailure(error: unknown): Response {
  if (error instanceof GoogleServiceError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status >= 400 && error.status < 600 ? error.status : 502, headers: NO_STORE }
    );
  }
  console.error("[google]", error);
  return Response.json({ error: "Google is not available right now.", code: "failed" }, { status: 500, headers: NO_STORE });
}
