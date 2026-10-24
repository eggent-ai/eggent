import { NextRequest } from "next/server";
import { browserAvailable, setBrowserControl } from "@/lib/browser/config";
import { forgetBrowserLogins } from "@/lib/browser/gateway";
import { stopWatchingBrowser } from "@/lib/browser/viewer";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/browser/profile - close the browser and forget every sign-in it kept. */
export async function DELETE(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!browserAvailable()) return jsonError("unavailable", 404);
  stopWatchingBrowser("sign-ins forgotten");
  setBrowserControl("agent");
  const ok = await forgetBrowserLogins().catch(() => false);
  return Response.json({ ok }, { status: ok ? 200 : 502 });
}
