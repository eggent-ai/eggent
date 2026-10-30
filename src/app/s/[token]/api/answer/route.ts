import type { NextRequest } from "next/server";
import { guestAnswer } from "@/lib/external/guest-turn";
import { conversationIdOf, ownsConversation, visitorSessionId } from "@/lib/public-chat/visitors";
import { fail, linkContext, NO_STORE } from "@/lib/public-chat/route-helpers";

/** POST /s/<token>/api/answer {conversation, interactionId, value?, cancel?} -> {answered}: only in the visitor'"'"'s own conversation. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: true });
  if (context instanceof Response) return context;
  const { token, visitor } = context;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const conversation = conversationIdOf(body?.conversation);
  if (!visitor || !conversation || !ownsConversation(visitor, conversation)) return fail("There is no such conversation.", 404, "noConversation");
  const sessionId = visitorSessionId(token, visitor.id, conversation);
  const answered = await guestAnswer(sessionId, {
    interactionId: typeof body?.interactionId === "string" ? body.interactionId : "",
    value: body?.value,
    cancel: body?.cancel === true,
  });
  return Response.json({ answered }, { headers: NO_STORE });
}
