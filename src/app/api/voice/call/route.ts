import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { voiceAvailable, voiceRequest } from "@/lib/voice/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/voice/call - whether calls are offered here and the minutes left.
 * POST /api/voice/call - starts a call: the deployment answers with a
 * short-lived secret for the voice model, which only this person's page gets.
 * Both behind the same checks as the terminal: a session of this site, and
 * JSON for the write, since a secret is handed back.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!voiceAvailable()) return Response.json({ available: false }, { headers: NO_STORE });
  const answer = await voiceRequest("GET", "/call").catch(() => null);
  if (!answer?.ok) return Response.json({ available: false }, { headers: NO_STORE });
  return Response.json({ available: Boolean(answer.json.available), minutes: answer.json.minutes ?? null }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!voiceAvailable()) return jsonError("unavailable", 404);
  await req.json().catch(() => null);
  const answer = await voiceRequest("POST", "/call").catch(() => null);
  if (!answer) return Response.json({ error: "The voice service could not be reached." }, { status: 502, headers: NO_STORE });
  if (!answer.ok) {
    return Response.json(
      { error: String(answer.json.error || `status ${answer.status}`), code: answer.json.code ?? null, minutes: answer.json.minutes ?? null },
      { status: answer.status, headers: NO_STORE }
    );
  }
  const call = (answer.json.call || {}) as Record<string, unknown>;
  return Response.json(
    {
      callId: call.id,
      secret: answer.json.secret,
      realtimeUrl: answer.json.realtimeUrl,
      model: answer.json.model,
      voice: answer.json.voice,
      maxSeconds: answer.json.maxSeconds,
      beatSeconds: answer.json.beatSeconds,
      minutes: answer.json.minutes,
    },
    { status: 201, headers: NO_STORE }
  );
}
