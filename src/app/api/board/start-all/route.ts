import type { NextRequest } from "next/server";
import { startInbox } from "@/lib/board/cards";
import { kickBoard } from "@/lib/board/dispatcher";
import { boardErrorResponse, guardBoardRequest, readJsonBody } from "@/lib/board/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/board/start-all - `{ projectId? }`: every card in the inbox (of that project) into the queue, in order. */
export async function POST(req: NextRequest) {
  const refused = await guardBoardRequest(req, true);
  if (refused) return refused;
  const body = await readJsonBody(req);
  try {
    const started = await startInbox(typeof body.projectId === "string" ? body.projectId : undefined);
    kickBoard();
    return Response.json({ started });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}
