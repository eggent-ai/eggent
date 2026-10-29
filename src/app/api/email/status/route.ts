import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { fetchEmailStatus } from "@/lib/email/client";
import { getEmailConfig } from "@/lib/email/config";
import { NO_STORE } from "@/lib/email/route-helpers";

/**
 * Whether this workspace has a mailbox to show, its address and what is
 * unread: what the sidebar's Mail row needs. `{ enabled: false }` hides it,
 * also when the service cannot be reached - a missed look is not news.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (getEmailConfig()?.mode !== "service") return Response.json({ enabled: false }, { headers: NO_STORE });
  try {
    const status = await fetchEmailStatus();
    if (!status.enabled) return Response.json({ enabled: false }, { headers: NO_STORE });
    return Response.json(
      { enabled: true, address: status.address ?? null, unread: { inbox: status.unread?.inbox ?? 0, other: status.unread?.other ?? 0 } },
      { headers: NO_STORE }
    );
  } catch {
    return Response.json({ enabled: false, unreachable: true }, { headers: NO_STORE });
  }
}
