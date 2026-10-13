import type { NextRequest } from "next/server";
import { fetchMailContacts, MailServiceError } from "@/lib/mail/client";
import { mailEnabled } from "@/lib/mail/config";
import { mailFailure, mailGuard, NO_STORE } from "@/lib/mail/route-helpers";

/**
 * Who this workspace can write to, with what is unread from each. Answers
 * `enabled: false` when the workspace has no messages at all - no service, or
 * a workspace that is not in a company - so the sidebar simply has no section.
 */
export async function GET(req: NextRequest) {
  const refused = await mailGuard(req, { write: false });
  if (refused) return refused;
  if (!mailEnabled()) return Response.json({ enabled: false }, { headers: NO_STORE });
  try {
    return Response.json(await fetchMailContacts(), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof MailServiceError && error.code === "notInCompany") return Response.json({ enabled: false }, { headers: NO_STORE });
    return mailFailure(error);
  }
}
