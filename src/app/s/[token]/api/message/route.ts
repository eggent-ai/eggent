import type { NextRequest } from "next/server";
import { guestTurnResponse, GuestTurnError } from "@/lib/external/guest-turn";
import { ExternalMessageError } from "@/lib/external/handle-external-message";
import { addConversation, conversationIdOf, newConversationId, ownsConversation, visitorSessionId } from "@/lib/public-chat/visitors";
import { clientAddress, fail, linkContext, withinLimit } from "@/lib/public-chat/route-helpers";

export const maxDuration = 300;

/**
 * POST /s/<token>/api/message {message, conversation?}
 *
 * The answer, as the workspace chat's own stream; a new conversation is named
 * in X-Eggent-Conversation. Only a visitor's own conversation can be written
 * to, and a visitor asks no more than the link allows in an hour.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: true });
  if (context instanceof Response) return context;
  const { token, share, visitor } = context;
  if (!visitor) return fail("Write your name and email first.", 401, "noVisitor");
  const body = (await req.json().catch(() => null)) as { message?: unknown; conversation?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message.trim()) return fail("The message is empty.", 400, "emptyMessage");
  let conversation: string | null = null;
  if (body?.conversation !== undefined && body?.conversation !== null && body?.conversation !== "") {
    conversation = conversationIdOf(body.conversation);
    if (!conversation || !ownsConversation(visitor, conversation)) return fail("There is no such conversation.", 404, "noConversation");
  }
  if (!withinLimit("message", `${token}:${visitor.id}`, share.maxMessagesPerHour) || !withinLimit("message-ip", `${token}:${clientAddress(req)}`, share.maxMessagesPerHour * 3)) {
    return fail("Too many questions in an hour. Try again later.", 429, "rateLimited");
  }
  if (!conversation) {
    conversation = newConversationId();
    if (!(await addConversation(token, visitor.id, conversation))) return fail("You have as many conversations here as you may.", 409, "tooManyConversations");
  }
  try {
    const response = await guestTurnResponse({
      sessionId: visitorSessionId(token, visitor.id, conversation),
      projectId: share.projectId,
      message,
      // Hidden from the model: who is writing, stamped on any answers they leave.
      toolRuntimeData: {
        publicAnswers: {
          file: `link-${share.title}`,
          visitor: { name: visitor.name, email: visitor.email, confirmed: Boolean(visitor.confirmedAt), conversation },
        },
      },
    });
    response.headers.set("X-Eggent-Conversation", conversation);
    return response;
  } catch (error) {
    if (error instanceof GuestTurnError) return fail(error.message, error.status, error.code);
    if (error instanceof ExternalMessageError) return Response.json(error.payload, { status: error.status });
    console.error("[public-chat]", error);
    return fail("The project could not answer. Try again in a minute.", 500, "failed");
  }
}
