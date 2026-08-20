import { NextResponse } from "next/server";
import { enableEggentAiModelLock, getPiModelsState } from "@/lib/pi/config-store";

/**
 * Switch the workspace back to the included Eggent AI model.
 *
 * Leaving it only writes an override file and keeps the credential, so coming
 * back is a state change rather than a re-authentication. Without this the
 * settings screen could only offer an empty API-key box for a key the
 * workspace already holds.
 *
 * The switch also repairs the included model's entry in models.json when it has
 * been edited away, and reports that back so the screen can say what it did
 * rather than quietly rewriting a file the user was editing.
 */
export async function POST() {
  try {
    const repair = await enableEggentAiModelLock();
    return NextResponse.json({ ...(await getPiModelsState()), repair });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to switch back to Eggent AI" },
      { status: 400 }
    );
  }
}
