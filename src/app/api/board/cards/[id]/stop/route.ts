import type { NextRequest } from "next/server";
import { stopCardWork } from "@/lib/board/cards";
import { boardErrorResponse, guardBoardRequest } from "@/lib/board/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/board/cards/:id/stop - stop it where it is; a card still in the queue goes back to the inbox. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await guardBoardRequest(req, true);
  if (refused) return refused;
  try {
    return Response.json({ card: await stopCardWork((await params).id) });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}
