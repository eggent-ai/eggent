import type { NextRequest } from "next/server";
import { controlCompanyConversation } from "@/lib/company-projects/client";
import { companyProjectIdOf, companyProjectsFailure, companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";
import { conversationIdOf } from "@/lib/company-projects/types";

/** POST /api/company-projects/<id>/answer {conversation, interactionId, value?, cancel?} -> {answered} */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await companyProjectsGuard(req, { write: true });
  if (refused) return refused;
  const id = companyProjectIdOf((await params).id);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const conversation = conversationIdOf(typeof body?.conversation === "string" ? body.conversation : "");
  if (!id || !conversation) return Response.json({ error: "Not found.", code: "noConversation" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json(await controlCompanyConversation(id, "answer", {
      conversation,
      interactionId: typeof body?.interactionId === "string" ? body.interactionId : "",
      value: typeof body?.value === "string" || typeof body?.value === "boolean" ? body.value : null,
      cancel: body?.cancel === true,
    }), { headers: NO_STORE });
  } catch (error) {
    return companyProjectsFailure(error);
  }
}
