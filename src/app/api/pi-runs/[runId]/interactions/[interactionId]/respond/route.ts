import { NextRequest } from "next/server";
import { respondToPendingInteraction } from "@/lib/pi/pending-interactions";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; interactionId: string }> }
) {
  try {
    const { runId, interactionId } = await params;
    const body = await req.json().catch(() => ({}));
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
