import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { EmailServiceError } from "@/lib/email/client";
import { getEmailConfig } from "@/lib/email/config";

/**
 * The checks every email route makes for itself: a signed-in session, a
 * request from this workspace's own pages, JSON for a write (see
 * terminal/guard.ts) - and a mailbox kept by a service, since a workspace that
 * only sends through its own server has no letters to show.
 */
export async function emailGuard(req: NextRequest, options: { write: boolean }): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, options);
  if (failure) return jsonError(failure, guardStatus(failure));
  if (getEmailConfig()?.mode !== "service") {
    return Response.json({ error: "This workspace has no mailbox.", code: "notConfigured" }, { status: 404, headers: NO_STORE });
  }
  return null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The service's own sentence and code, under the status it gave. */
export function emailFailure(error: unknown): Response {
  if (error instanceof EmailServiceError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status >= 400 && error.status < 600 ? error.status : 502, headers: NO_STORE });
  }
  console.error("[email]", error);
  return Response.json({ error: "The mailbox is not available right now.", code: "failed" }, { status: 500, headers: NO_STORE });
}

export function letterIdOf(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}
