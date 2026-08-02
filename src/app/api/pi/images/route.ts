import { NextResponse } from "next/server";
import { getPiModelsState, setImageGenerationBackend } from "@/lib/pi/config-store";

/**
 * Choose which provider and model answer image requests.
 *
 * Only meaningful for a workspace running on its own model: while the included
 * model is active it serves images too, and nothing here is needed. Sending an
 * empty provider clears the choice.
 */
export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { provider?: unknown; model?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    await setImageGenerationBackend(provider ? { provider, model } : null);
    return NextResponse.json(await getPiModelsState());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save the image model" },
      { status: 400 }
    );
  }
}
