import type { NextRequest } from "next/server";
import { fetchCompanyConversation } from "@/lib/company-projects/client";
import { companyProjectIdOf, companyProjectsFailure, companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";
import { conversationIdOf } from "@/lib/company-projects/types";

/** GET /api/company-projects/<id>/chats/<conversation> -> { chat } */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; conversation: string }> }) {
  const refused = await companyProjectsGuard(req, { write: false });
  if (refused) return refused;
  const raw = await params;
  const id = companyProjectIdOf(raw.id);
  const conversation = conversationIdOf(raw.conversation);
  if (!id || !conversation) return Response.json({ error: "Not found.", code: "noConversation" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json({ chat: await fetchCompanyConversation(id, conversation) }, { headers: NO_STORE });
  } catch (error) {
    return companyProjectsFailure(error);
  }
}
