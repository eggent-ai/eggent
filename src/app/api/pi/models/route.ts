import { NextRequest, NextResponse } from "next/server";
import { getPiModelsState, readPiModelsJson, writePiModelsJson } from "@/lib/pi/config-store";

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("raw") === "1";
    if (raw) {
      return NextResponse.json({ content: await readPiModelsJson() });
    }
    return NextResponse.json(await getPiModelsState());
  } catch (error) {
    console.error("[eggent] Failed to load model settings", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load model settings." },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as { content?: unknown } | null;
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: 'Field "content" must be a string.' }, { status: 400 });
  }
  try {
    const content = await writePiModelsJson(body.content);
    return NextResponse.json({ content, state: await getPiModelsState() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save pi models.json" },
      { status: 400 }
    );
  }
}
