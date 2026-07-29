import { NextRequest, NextResponse } from "next/server";
import { getUsageSnapshot, isUsageProviderConfigured } from "@/lib/usage/usage-provider";

export async function GET(req: NextRequest) {
  if (!isUsageProviderConfigured()) {
    // No usage provider is configured for this deployment, so the concept does
    // not exist here. Callers use this to hide the feature entirely.
    return NextResponse.json({ error: "No usage provider configured." }, { status: 404 });
  }

  const force = req.nextUrl.searchParams.get("refresh") === "1";
  const snapshot = await getUsageSnapshot({ force });
  if (!snapshot) {
    return NextResponse.json({ error: "Usage provider is unavailable." }, { status: 503 });
  }

  return NextResponse.json(snapshot);
}
