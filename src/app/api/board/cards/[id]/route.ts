import type { NextRequest } from "next/server";
import { deleteCard, editCard, moveCard, type MoveTarget } from "@/lib/board/cards";
import { kickBoard } from "@/lib/board/dispatcher";
import { boardErrorResponse, guardBoardRequest, readJsonBody, stringList } from "@/lib/board/http";
import { getCard } from "@/lib/board/store";
import { jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MOVE_TARGETS: readonly MoveTarget[] = ["inbox", "queued", "done", "archived", "unarchived"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await guardBoardRequest(req, false);
  if (refused) return refused;
  const card = await getCard((await params).id);
  if (!card) return jsonError("No such card", 404);
  return Response.json({ card }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * PATCH /api/board/cards/:id - change what a card says, or where it is.
 *
 * `{ title, body, projectId, after, review }` edits it; `{ move: { to, position } }`
 * moves it to another column (or to another place in its own).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await guardBoardRequest(req, true);
  if (refused) return refused;
  const { id } = await params;
  const body = await readJsonBody(req);
  try {
    let card = null;
    const edits = {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(typeof body.projectId === "string" || body.projectId === null ? { projectId: (body.projectId as string | null) ?? null } : {}),
      ...(Array.isArray(body.after) ? { after: stringList(body.after) } : {}),
      ...(typeof body.review === "boolean" ? { review: body.review } : {}),
    };
    if (Object.keys(edits).length > 0) card = await editCard(id, edits, "person");
    const move = body.move && typeof body.move === "object" ? (body.move as { to?: unknown; position?: unknown }) : null;
    if (move) {
      const to = MOVE_TARGETS.find((target) => target === move.to);
      if (!to) return jsonError("Unknown column", 400);
      card = await moveCard(id, to, typeof move.position === "number" ? { position: move.position } : {});
    }
    if (!card) card = await getCard(id);
    if (!card) return jsonError("No such card", 404);
    kickBoard();
    return Response.json({ card });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}

/** DELETE /api/board/cards/:id - the card and its conversation. The files it made stay. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // A DELETE carries no body; the same-site check is what stands in front of it.
  const refused = await guardBoardRequest(req, false);
  if (refused) return refused;
  try {
    await deleteCard((await params).id, "person");
    kickBoard();
    return Response.json({ success: true });
  } catch (error) {
    return boardErrorResponse(req, error);
  }
}
