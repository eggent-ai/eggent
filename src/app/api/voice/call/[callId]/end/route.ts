import { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { isStoredMessageId } from "@/lib/pi/steer-shape";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { isCallId, voiceAvailable, voiceRequest } from "@/lib/voice/gateway";
import { recordVoiceCall } from "@/lib/voice/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/voice/call/<id>/end { chatId, projectId?, seconds, transcript, summary, delegated }
 *
 * The call is over: the deployment is told (it counts the minutes from its own
 * clock, not from `seconds`), and the call is put into the chat it was held in
 * as a card with what was said and the short summary.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ callId: string }> }) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  const { callId } = await params;
  if (!isCallId(callId)) return jsonError("call", 400);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return jsonError("body", 400);

  let counted: number | null = null;
  if (voiceAvailable()) {
    const answer = await voiceRequest("DELETE", `/call/${callId}`).catch(() => null);
    if (answer?.ok && typeof answer.json.seconds === "number" && answer.json.seconds > 0) counted = answer.json.seconds;
  }

  const chatId = body.chatId;
  if (!isStoredMessageId(chatId)) return Response.json({ ok: true, recorded: false, seconds: counted });
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const message = await recordVoiceCall({
    chatId,
    projectId: typeof body.projectId === "string" && /^[\w-]{1,120}$/.test(body.projectId) ? body.projectId : undefined,
    seconds: counted ?? body.seconds,
    transcript: body.transcript,
    summary: body.summary,
    delegated: body.delegated,
    title: t("voice.chatTitle"),
  });
  return Response.json({ ok: true, recorded: Boolean(message), messageId: message?.id ?? null, seconds: counted });
}
