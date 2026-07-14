import { NextResponse } from "next/server";
import { getEggentSyncthingStatus } from "@/lib/syncthing/client";

export async function GET() {
  return NextResponse.json(await getEggentSyncthingStatus());
}
