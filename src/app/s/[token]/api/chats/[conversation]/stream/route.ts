import type { NextRequest } from "next/server";
import { guestResumeResponse } from "@/lib/external/guest-turn";
import { conversationIdOf, ownsConversation, visitorSessionId } from "@/lib/public-chat/visitors";
import { fail, linkContext } from "@/lib/public-chat/route-helpers";

export const maxDuration = 300;

/** GET /s/<token>/api/chats/<conversation>/stream -> the turn working in it now, from its start, or 204. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; conversation: string }> }) {
  const raw = await params;
  const context = await linkContext(req, raw.token, { write: false });
  if (context instanceof Response) return context;
  const { token, visitor } = context;
  const conversation = conversationIdOf(raw.conversation);
  if (!visitor || !conversation || !ownsConversation(visitor, conversation)) return fail("There is no such conversation.", 404, "noConversation");
  return await guestResumeResponse(visitorSessionId(token, visitor.id, conversation), req.signal);
}
