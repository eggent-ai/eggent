import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { appsEnabled } from "@/lib/apps/tool";

/**
 * Whether this workspace offers connected services, for the sidebar's "Apps":
 *
 *   GET /api/apps/status  ->  { enabled: false } | { enabled: true, url }
 *
 * The page itself is the deployment's, at /__eggent/apps on this same address.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  return Response.json(appsEnabled() ? { enabled: true, url: "/__eggent/apps" } : { enabled: false }, { headers: { "Cache-Control": "no-store" } });
}
