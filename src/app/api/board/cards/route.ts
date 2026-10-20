import type { NextRequest } from "next/server";
import { createCards } from "@/lib/board/cards";
import { kickBoard } from "@/lib/board/dispatcher";
import { boardErrorResponse, guardBoardRequest, readJsonBody, stringList } from "@/lib/board/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/board/cards - the person writes a card.
 *
 * `{ title, body, projectId, after, review, start }`. With `start` it goes into
 * the queue at once; without, it waits in the inbox.
 */
export async function POST(req: NextRequest) {
  const refused = await guardBoardRequest(req, true);
  if (refused) return refused;
  const body = await readJsonBody(req);
  try {
    const [card] = await createCards(
      [
        {
          title: typeof body.title === "string" ? body.title : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          after: stringList(body.after),
          review: body.review === true,
        },
      ],
      { createdBy: "person", start: body.start === true }
    );
    kickBoard();
    return Response.json({ card }, { status: 201 });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}
