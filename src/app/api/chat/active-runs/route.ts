import { listLiveRuns } from "@/lib/pi/live-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which chats are working right now.
 *
 * The sidebar marks them, and the open chat uses it to decide whether there is
 * a turn worth attaching to. It reports only runs that can actually be watched,
 * so a mark here always has something behind it.
 */
export async function GET() {
  return Response.json({ runs: listLiveRuns() });
}
