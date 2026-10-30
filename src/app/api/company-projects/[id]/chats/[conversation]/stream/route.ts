import type { NextRequest } from "next/server";
import { streamCompanyConversation } from "@/lib/company-projects/client";
import { companyProjectIdOf, companyProjectsFailure, companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";
import { conversationIdOf } from "@/lib/company-projects/types";

export const maxDuration = 300;

/** GET /api/company-projects/<id>/chats/<conversation>/stream -> the turn working now, from its start, or 204 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; conversation: string }> }) {
  const refused = await companyProjectsGuard(req, { write: false });
  if (refused) return refused;
  const raw = await params;
  const id = companyProjectIdOf(raw.id);
  const conversation = conversationIdOf(raw.conversation);
  if (!id || !conversation) return Response.json({ error: "Not found.", code: "noConversation" }, { status: 404, headers: NO_STORE });
  try {
    const upstream = await streamCompanyConversation(id, conversation, req.signal);
    if (upstream.status === 204 || !upstream.body) return new Response(null, { status: 204, headers: NO_STORE });
    return new Response(upstream.body, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    return companyProjectsFailure(error);
  }
}
