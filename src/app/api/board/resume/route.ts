import type { NextRequest } from "next/server";
import { resumeBoard } from "@/lib/board/cards";
import { kickBoard } from "@/lib/board/dispatcher";
import { boardErrorResponse, guardBoardRequest } from "@/lib/board/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/board/resume - the board may start cards again after the model service refused one. */
export async function POST(req: NextRequest) {
  const refused = await guardBoardRequest(req, true);
  if (refused) return refused;
  try {
    await resumeBoard();
    kickBoard();
    return Response.json({ success: true });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}
