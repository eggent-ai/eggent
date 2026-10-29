import type { NextRequest } from "next/server";
import { fetchCompanyConversations } from "@/lib/company-projects/client";
import { companyProjectIdOf, companyProjectsFailure, companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";

/** GET /api/company-projects/<id>/chats -> { chats }: this person's conversations with the project. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await companyProjectsGuard(req, { write: false });
  if (refused) return refused;
  const id = companyProjectIdOf((await params).id);
  if (!id) return Response.json({ error: "Not found.", code: "notShared" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json({ chats: await fetchCompanyConversations(id) }, { headers: NO_STORE });
  } catch (error) {
    return companyProjectsFailure(error);
  }
}
