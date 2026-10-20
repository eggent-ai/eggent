import type { NextRequest } from "next/server";
import { guardBoardRequest } from "@/lib/board/http";
import { listCards, readBoardState } from "@/lib/board/store";
import type { BoardSummary } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/board/summary - what the sidebar's board entry counts. */
export async function GET(req: NextRequest) {
  const refused = await guardBoardRequest(req, false);
  if (refused) return refused;
  const cards = (await listCards()).filter((card) => !card.archived);
  const summary: BoardSummary = {
    waiting: cards.filter((card) => card.status === "waiting").length,
    running: cards.filter((card) => card.status === "running").length,
    queued: cards.filter((card) => card.status === "queued").length,
    paused: Boolean((await readBoardState()).paused),
  };
  return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
}
