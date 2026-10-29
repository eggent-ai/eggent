import type { NextRequest } from "next/server";
import { askCompanyProject } from "@/lib/company-projects/client";
import { companyProjectIdOf, companyProjectsFailure, companyProjectsGuard, NO_STORE } from "@/lib/company-projects/route-helpers";
import { conversationIdOf } from "@/lib/company-projects/types";

/**
 * POST /api/company-projects/<id>/message {message, conversation?}
 *
 * The answer comes back as server-sent events, exactly as the project's own
 * workspace writes them ({type: "text" | "tool" | "done" | "error"}); the
 * conversation it went into is in the X-Eggent-Conversation header.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await companyProjectsGuard(req, { write: true });
  if (refused) return refused;
  const id = companyProjectIdOf((await params).id);
  if (!id) return Response.json({ error: "Not found.", code: "notShared" }, { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { message?: unknown; conversation?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "The message is empty.", code: "emptyMessage" }, { status: 400, headers: NO_STORE });
  const conversation = body?.conversation === undefined || body?.conversation === null || body?.conversation === ""
    ? undefined
    : conversationIdOf(String(body.conversation));
  if (conversation === null) return Response.json({ error: "There is no such conversation.", code: "noConversation" }, { status: 404, headers: NO_STORE });
  try {
    const upstream = await askCompanyProject(id, { message, ...(conversation ? { conversation } : {}) }, req.signal);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Eggent-Conversation": conversationIdOf(upstream.headers.get("x-eggent-conversation")) || "",
      },
    });
  } catch (error) {
    return companyProjectsFailure(error);
  }
}
