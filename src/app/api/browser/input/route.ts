import { NextRequest } from "next/server";
import { pageAddress } from "@/lib/browser/address";
import { browserAvailable } from "@/lib/browser/config";
import { browserViewerKeys, sendBrowserInput, type ViewerInput } from "@/lib/browser/viewer";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function finite(value: unknown, max: number): number | null {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}

/**
 * POST /api/browser/input - a click, a scroll, a key or some text from the
 * panel, while the person has control. Coordinates are in the page's own CSS
 * pixels, which the panel works out from the frame it shows. The address bar
 * comes here too: an address to open, Back, Forward and Reload.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!browserAvailable()) return jsonError("unavailable", 404);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  let input: ViewerInput | null = null;
  const x = finite(body.x, 10_000);
  const y = finite(body.y, 10_000);
  if (body.type === "click" && x !== null && y !== null) input = { type: "click", x, y };
  if (body.type === "wheel" && x !== null && y !== null) {
    const deltaY = finite(body.deltaY, 5_000);
    if (deltaY !== null) input = { type: "wheel", x, y, deltaY };
  }
  if (body.type === "key" && typeof body.key === "string" && browserViewerKeys().includes(body.key)) input = { type: "key", key: body.key };
  if (body.type === "text" && typeof body.text === "string" && body.text.length > 0 && body.text.length <= 2000) input = { type: "text", text: body.text };
  if (body.type === "navigate") {
    const url = typeof body.url === "string" ? pageAddress(body.url) : null;
    if (!url) return jsonError("not-an-address", 400);
    input = { type: "navigate", url };
  }
  if (body.type === "back" || body.type === "forward" || body.type === "reload") input = { type: body.type };
  if (!input) return jsonError("input", 400);
  const outcome = await sendBrowserInput(input).catch((error: unknown) => {
    console.error("[browser] the panel's input did not reach the page:", error instanceof Error ? error.message : error);
    return "not-connected" as const;
  });
  if (outcome === "not-yours") return jsonError("not-in-control", 409);
  if (outcome === "not-connected") return jsonError("not-connected", 409);
  if (typeof outcome === "object") return Response.json({ ok: false, error: "did-not-open", reason: outcome.failed }, { status: 422 });
  return Response.json({ ok: true });
}
