import { NextRequest } from "next/server";
import { browserAvailable, setBrowserControl } from "@/lib/browser/config";
import { closeBrowser, openBrowser } from "@/lib/browser/gateway";
import { stopWatchingBrowser } from "@/lib/browser/viewer";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/browser/session { action: "open" | "close" }
 *
 * A person opens the browser themselves to sign in somewhere before the agent
 * needs it, or closes it when they are done. Opening it by hand hands them
 * control, since they opened it to do something themselves; closing gives
 * control back.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!browserAvailable()) return jsonError("unavailable", 404);
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (body.action === "close") {
    stopWatchingBrowser("closed by the person");
    setBrowserControl("agent");
    await closeBrowser().catch(() => undefined);
    return Response.json({ ok: true });
  }
  if (body.action !== "open") return jsonError("action", 400);
  const opened = await openBrowser();
  if (!opened.ok) return Response.json({ ok: false, error: opened.error }, { status: 409 });
  setBrowserControl("person");
  return Response.json({ ok: true, ...opened.status, control: "person" });
}
