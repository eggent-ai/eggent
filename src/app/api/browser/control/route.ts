import { NextRequest } from "next/server";
import { browserAvailable, setBrowserControl } from "@/lib/browser/config";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/browser/control { take: boolean }
 *
 * The person takes the browser (the agent's program waits) or hands it back.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!browserAvailable()) return jsonError("unavailable", 404);
  const body = (await req.json().catch(() => ({}))) as { take?: unknown };
  setBrowserControl(body.take === true ? "person" : "agent");
  return Response.json({ ok: true, control: body.take === true ? "person" : "agent" });
}
