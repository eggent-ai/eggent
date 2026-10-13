import { NextRequest } from "next/server";
import { stopActiveRun } from "@/lib/pi/active-runs";
import { getLiveRun, whenLiveRunFinished } from "@/lib/pi/live-run";
import { settleWaitMs } from "@/lib/remote/config";

export const runtime = "nodejs";

/**
 * Stop the turn working in this chat.
 *
 * Dropping the HTTP request used to be how this was done, which made "stop"
 * and "I am closing this tab" the same gesture. Only one of them means stop.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  if (!chatId) {
    return Response.json({ error: "Chat ID required" }, { status: 400 });
  }

  // Looked at before the stop: a turn that winds down is gone from the registry a moment later.
  const relayed = Boolean(getLiveRun(chatId)?.home);
  const stopped = await stopActiveRun(chatId);
  // Answer only once the turn has wound down and written what it got to. The
  // caller reloads the conversation as soon as this returns, and a reply that
  // beats the file makes the half-written answer disappear off the screen of
  // the person who just chose to keep it.
  //
  // A turn that ran on the other side is not written down until that side's copy
  // of the chat arrives here, which is as long as the screen is willing to wait
  // for it: answering earlier made the answer the person chose to keep vanish
  // and come back when the sync caught up.
  if (stopped) await whenLiveRunFinished(chatId, relayed ? settleWaitMs() + 5_000 : undefined);
  return Response.json({ stopped });
}
