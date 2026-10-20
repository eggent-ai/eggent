import { NextRequest } from "next/server";
import { localNode, localNodeName, remoteEnabled } from "@/lib/remote/config";
import { listDevices } from "@/lib/remote/relay-client";
import type { RemoteDevice, RemoteStatus } from "@/lib/remote/types";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the chat screen needs to draw the switch that says where a chat runs:
 * whether the feature exists here at all, what this side is, and which
 * computers a workspace could hand a chat to right now.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));

  const node = localNode();
  if (!remoteEnabled() || !node) {
    const off: RemoteStatus = { enabled: false, node: null, nodeName: null, devices: [], reachable: false };
    return Response.json(off, { headers: { "Cache-Control": "no-store" } });
  }

  let devices: RemoteDevice[] = [];
  let reachable = true;
  try {
    devices = await listDevices(req.signal);
  } catch {
    reachable = false;
  }

  const status: RemoteStatus = {
    enabled: true,
    node,
    nodeName: localNodeName(),
    // A computer's only other place is the workspace; the list is the workspace's.
    devices: node === "cloud" ? devices : [],
    // What a computer is told about itself: whether the cloud could start a card here.
    self: node === "cloud" ? null : devices.find((device) => device.node === node) ?? null,
    reachable,
  };
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
