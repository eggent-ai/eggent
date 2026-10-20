import type { NextRequest } from "next/server";
import { boardLimits, liveCards } from "@/lib/board/dispatcher";
import { guardBoardRequest } from "@/lib/board/http";
import { listCards, readBoardState } from "@/lib/board/store";
import { localNode, remoteEnabled } from "@/lib/remote/config";
import type { BoardSnapshot } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/board - every card, the board's state, and which cards have a turn
 * running in their chat right now. `?archived=1` includes the cards put away.
 */
export async function GET(req: NextRequest) {
  const refused = await guardBoardRequest(req, false);
  if (refused) return refused;
  const withArchived = req.nextUrl.searchParams.get("archived") === "1";
  const all = await listCards();
  const cards = withArchived ? all : all.filter((card) => !card.archived);
  const snapshot: BoardSnapshot = {
    cards,
    state: await readBoardState(),
    live: liveCards(cards),
    limits: boardLimits(),
    node: remoteEnabled() ? localNode() : null,
  };
  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
