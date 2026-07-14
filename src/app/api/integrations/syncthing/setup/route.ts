import { NextRequest, NextResponse } from "next/server";
import {
  acceptPendingEggentSyncthingDevice,
  addEggentSyncthingPeer,
  enableEggentSyncthing,
  getEggentSyncthingStatus,
  pauseEggentSyncthing,
  removeEggentSyncthingPeer,
} from "@/lib/syncthing/client";

type SyncthingAction = "enable" | "pause" | "resume" | "pair" | "accept" | "remove";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      action?: unknown;
      deviceId?: unknown;
      name?: unknown;
      address?: unknown;
    } | null;
    const action = typeof body?.action === "string" ? body.action as SyncthingAction : "";
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
    const name = typeof body?.name === "string" ? body.name : undefined;
    const address = typeof body?.address === "string" ? body.address : undefined;

    if (action === "enable") {
      await enableEggentSyncthing();
    } else if (action === "pause") {
      await pauseEggentSyncthing(true);
    } else if (action === "resume") {
      await pauseEggentSyncthing(false);
    } else if (action === "pair") {
      await addEggentSyncthingPeer({ deviceId, name, address });
    } else if (action === "accept") {
      await acceptPendingEggentSyncthingDevice({ deviceId, name });
    } else if (action === "remove") {
      await removeEggentSyncthingPeer(deviceId);
    } else {
      return NextResponse.json({ error: "Unknown Syncthing action." }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      status: await getEggentSyncthingStatus(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Syncthing setup failed." },
      { status: 400 }
    );
  }
}
