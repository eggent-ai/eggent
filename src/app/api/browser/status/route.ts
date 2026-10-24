import { NextRequest } from "next/server";
import { browserAvailable, browserControl } from "@/lib/browser/config";
import { browserStatus } from "@/lib/browser/gateway";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/browser/status
 *
 * Whether this workspace has a browser at all, whether one is open, the month's
 * minutes and who has control. `available: false` means the panel is not shown.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!browserAvailable()) return Response.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  try {
    const status = await browserStatus();
    return Response.json({ available: true, ...status, control: browserControl() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ available: true, open: false, error: error instanceof Error ? error.message : "unreachable", control: browserControl() }, { headers: { "Cache-Control": "no-store" } });
  }
}
