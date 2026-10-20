import { NextRequest } from "next/server";
import { isRunServedForRemote } from "@/lib/pi/active-runs";
import { respondToPendingInteraction } from "@/lib/pi/pending-interactions";
import { forwardInteractionResponse } from "@/lib/remote/proxy-turn";
import { REMOTE_HEADERS } from "@/lib/remote/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; interactionId: string }> }
) {
  try {
    const { runId, interactionId } = await params;
    // Over the relay, only the questions of a turn that was handed over that way.
    if (req.headers.get(REMOTE_HEADERS.relayed) === "1" && !isRunServedForRemote(runId)) {
      return Response.json({ error: "Pending interaction not found" }, { status: 404 });
    }
    const body = await req.json().catch(() => ({}));
    // A question asked by a turn that runs on the other side is answered there.
    const forwarded = await forwardInteractionResponse(runId, interactionId, {
      value: body?.value,
      cancel: body?.cancel === true,
    });
    if (forwarded) return forwarded;
    const interaction = respondToPendingInteraction(runId, interactionId, {
      value: body?.value,
      cancel: body?.cancel === true,
    });
    return Response.json({ interaction });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to respond to interaction" },
      { status: 404 }
    );
  }
}
