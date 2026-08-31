import { NextRequest } from "next/server";
import { stopActiveRun } from "@/lib/pi/active-runs";
import { whenLiveRunFinished } from "@/lib/pi/live-run";

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

  const stopped = await stopActiveRun(chatId);
  // Answer only once the turn has wound down and written what it got to. The
  // caller reloads the conversation as soon as this returns, and a reply that
  // beats the file makes the half-written answer disappear off the screen of
  // the person who just chose to keep it.
  if (stopped) await whenLiveRunFinished(chatId);
  return Response.json({ stopped });
}
