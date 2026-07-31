import { NextResponse } from "next/server";
import { deploymentNotice } from "@/lib/pi/config-store";

/**
 * What the operator of this deployment wants shown to users.
 *
 * Self-hosted Eggent normally configures nothing here and gets an empty notice.
 */
export async function GET() {
  return NextResponse.json({ notice: deploymentNotice() ?? null });
}
