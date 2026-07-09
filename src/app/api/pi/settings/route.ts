import { NextRequest, NextResponse } from "next/server";
import { getPiSettingsState, updatePiModelDefaults } from "@/lib/pi/config-store";

export async function GET() {
  return NextResponse.json(await getPiSettingsState());
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    provider?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
  } | null;

  try {
    const state = await updatePiModelDefaults({
      provider: typeof body?.provider === "string" ? body.provider : undefined,
      model: typeof body?.model === "string" ? body.model : undefined,
      thinkingLevel: typeof body?.thinkingLevel === "string" ? body.thinkingLevel : undefined,
    });
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update pi settings" },
      { status: 400 }
    );
  }
}
