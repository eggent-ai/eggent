import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { isCallId, voiceAvailable, voiceRequest } from "@/lib/voice/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/voice/call/<id> - the call is still going. Every few seconds while
 * the call runs; the deployment answers whether it may go on (`continue`) and
 * how long is left, and a call whose beats stop is ended there.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ callId: string }> }) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!voiceAvailable()) return jsonError("unavailable", 404);
  const { callId } = await params;
  if (!isCallId(callId)) return jsonError("call", 400);
  await req.json().catch(() => null);
  const answer = await voiceRequest("POST", `/call/${callId}/beat`).catch(() => null);
  if (!answer) return Response.json({ continue: true, unreachable: true });
  return Response.json(
    { continue: Boolean(answer.json.continue), leftSeconds: answer.json.leftSeconds ?? null, reason: answer.json.reason ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
