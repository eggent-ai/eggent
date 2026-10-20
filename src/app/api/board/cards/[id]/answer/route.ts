import type { NextRequest } from "next/server";
import { answerCard } from "@/lib/board/cards";
import { kickBoard } from "@/lib/board/dispatcher";
import { boardErrorResponse, guardBoardRequest, readJsonBody } from "@/lib/board/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/board/cards/:id/answer - `{ text }`, the answer to the card's question. Its next run starts with it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await guardBoardRequest(req, true);
  if (refused) return refused;
  const body = await readJsonBody(req);
  try {
    const card = await answerCard((await params).id, typeof body.text === "string" ? body.text : "");
    kickBoard();
    return Response.json({ card });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}
