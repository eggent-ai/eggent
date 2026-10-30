import type { NextRequest } from "next/server";
import { guestConversationSummary } from "@/lib/external/guest-turn";
import { visitorMailAvailable } from "@/lib/public-chat/shares";
import { visitorSessionId } from "@/lib/public-chat/visitors";
import { linkContext, NO_STORE } from "@/lib/public-chat/route-helpers";

/**
 * GET /s/<token>/api -> what the link's page needs to begin: the project's name
 * and welcome, who this browser writes as (if anyone), and their conversations.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: false });
  if (context instanceof Response) return context;
  const { token, share, visitor } = context;
  const conversations = [];
  for (const item of visitor ? [...visitor.conversations].reverse().slice(0, 50) : []) {
    const summary = await guestConversationSummary(visitorSessionId(token, visitor!.id, item.id));
    if (summary && summary.messages > 0) conversations.push({ id: item.id, ...summary });
  }
  return Response.json({
    share: { title: share.title, welcome: share.welcome },
    visitor: visitor ? { name: visitor.name, email: visitor.email, confirmed: Boolean(visitor.confirmedAt) } : null,
    conversations: conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    mail: visitorMailAvailable(),
  }, { headers: NO_STORE });
}
