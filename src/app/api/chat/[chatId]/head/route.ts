import { NextRequest } from "next/server";
import { getActiveRun } from "@/lib/pi/active-runs";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { readChatHead } from "@/lib/remote/head";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How far this side has got with one chat: the last message it holds and the
 * last entry of the agent's own record of the conversation.
 *
 * The other side of a paired workspace and computer asks this to know what has
 * reached here - before it hands a turn over, and after a turn it ran for the
 * other side to see whether the files have caught up. It says nothing about the
 * conversation itself, only where it ends.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  // Checked here as well as by the middleware, which lets a path with a dot in its last part through.
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));

  const { chatId } = await params;
  if (!chatId) return jsonError("Chat ID required", 400);

  const head = await readChatHead(chatId);
  return Response.json(
    { ...head, running: Boolean(getActiveRun(chatId)) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
