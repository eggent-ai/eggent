import type { NextRequest } from "next/server";
import { guestChat } from "@/lib/external/guest-turn";
import { conversationIdOf, ownsConversation, visitorSessionId } from "@/lib/public-chat/visitors";
import { fail, linkContext, NO_STORE } from "@/lib/public-chat/route-helpers";

/** GET /s/<token>/api/chats/<conversation> -> {chat}: one of the visitor's own conversations. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; conversation: string }> }) {
  const raw = await params;
  const context = await linkContext(req, raw.token, { write: false });
  if (context instanceof Response) return context;
  const { token, visitor } = context;
  const conversation = conversationIdOf(raw.conversation);
  if (!visitor || !conversation || !ownsConversation(visitor, conversation)) return fail("There is no such conversation.", 404, "noConversation");
  const chat = await guestChat(visitorSessionId(token, visitor.id, conversation));
  return Response.json({ chat: chat ?? { title: "", messages: [], running: false } }, { headers: NO_STORE });
}
