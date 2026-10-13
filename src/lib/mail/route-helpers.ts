import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { MailServiceError } from "@/lib/mail/client";

/**
 * The checks every messages route makes for itself: a signed-in session, a
 * request from this workspace's own pages, and JSON for a write. A message is
 * sent in the person's name, so a page on a sibling workspace - same site,
 * cookie and all - must not be able to send one (see terminal/guard.ts).
 */
export async function mailGuard(req: NextRequest, options: { write: boolean; body?: "json" | "multipart" }): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, options);
  return failure ? jsonError(failure, guardStatus(failure)) : null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The service's own sentence and code, under the status it gave. */
export function mailFailure(error: unknown): Response {
  if (error instanceof MailServiceError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status >= 400 && error.status < 600 ? error.status : 502, headers: NO_STORE });
  }
  console.error("[mail]", error);
  return Response.json({ error: "Messages are not available right now.", code: "failed" }, { status: 500, headers: NO_STORE });
}
