import type { NextRequest } from "next/server";
import { refuseExternalCaller } from "@/lib/external/bearer";
import { guestAnswer, guestChat, guestResumeResponse, guestStop, guestTurnResponse, GuestTurnError } from "@/lib/external/guest-turn";
import { ExternalMessageError } from "@/lib/external/handle-external-message";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * A guest's conversation with a shared project, for the host that lets the
 * guest in (the company's service, for its people): the same token as
 * /api/external/message, every call scoped to one session id the host chose.
 *
 *   POST {action: "message", sessionId, projectId, message, opening?, toolRuntimeData?}
 *        -> the workspace chat's UI message stream
 *   POST {action: "stop", sessionId}                       -> {stopped}
 *   POST {action: "answer", sessionId, interactionId, value?, cancel?} -> {answered}
 *   GET  ?sessionId=...                 -> {chat: {title, messages, running} | null}
 *   GET  ?sessionId=...&view=stream     -> the turn working now, or 204
 *
 * Every guest turn is a public-share turn: the project's files to read, a card
 * to ask with, a row of answers to leave, and nothing else.
 */

const SESSION_ID = /^(?:share|company):[A-Za-z0-9._:-]{1,120}$/;

function sessionIdOf(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim() : "";
  return SESSION_ID.test(id) ? id : null;
}

function failure(error: unknown): Response {
  if (error instanceof GuestTurnError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof ExternalMessageError) return Response.json(error.payload, { status: error.status });
  console.error("[external/guest]", error);
  return Response.json({ error: "The answer could not be started." }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const refused = await refuseExternalCaller(req);
  if (refused) return refused;
  const sessionId = sessionIdOf(req.nextUrl.searchParams.get("sessionId"));
  if (!sessionId) return Response.json({ error: "A session id is required." }, { status: 400 });
  if (req.nextUrl.searchParams.get("view") === "stream") return await guestResumeResponse(sessionId, req.signal);
  return Response.json({ chat: await guestChat(sessionId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const refused = await refuseExternalCaller(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = sessionIdOf(body?.sessionId);
  if (!body || !sessionId) return Response.json({ error: "A session id is required." }, { status: 400 });
  try {
    if (body.action === "stop") return Response.json({ stopped: await guestStop(sessionId) });
    if (body.action === "answer") {
      const interactionId = typeof body.interactionId === "string" ? body.interactionId : "";
      return Response.json({ answered: await guestAnswer(sessionId, { interactionId, value: body.value, cancel: body.cancel === true }) });
    }
    if (body.action !== "message") return Response.json({ error: "Unknown action." }, { status: 400 });
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) return Response.json({ error: "A project is required." }, { status: 400 });
    const toolRuntimeData = body.toolRuntimeData && typeof body.toolRuntimeData === "object" && !Array.isArray(body.toolRuntimeData)
      ? body.toolRuntimeData as Record<string, unknown>
      : undefined;
    return await guestTurnResponse({
      sessionId,
      projectId,
      message: typeof body.message === "string" ? body.message : "",
      opening: typeof body.opening === "string" ? body.opening : undefined,
      toolRuntimeData,
    });
  } catch (error) {
    return failure(error);
  }
}
