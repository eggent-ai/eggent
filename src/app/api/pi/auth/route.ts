import { NextRequest, NextResponse } from "next/server";
import { deletePiCredential, disableEggentAiModelLock, getEggentAiModelLockState, getPiModelsState, getPiSettingsState, setPiApiKeyCredential, setPiDefaultToFirstAvailableModel } from "@/lib/pi/config-store";

export async function GET() {
  const state = await getPiModelsState();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    provider?: unknown;
    apiKey?: unknown;
    env?: unknown;
  } | null;

  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const env = body?.env && typeof body.env === "object" && !Array.isArray(body.env)
    ? Object.fromEntries(Object.entries(body.env).filter(([key, value]) => key && typeof value === "string"))
    : undefined;

  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  const lock = await getEggentAiModelLockState();
  if (lock.locked) {
    return NextResponse.json({ error: "Provider credentials are managed by Eggent AI for this workspace." }, { status: 403 });
  }

  await setPiApiKeyCredential(provider, apiKey, env);
  // The key is saved either way, so this is not an error status - but the
  // caller has to be able to tell that the workspace did not move onto it.
  const modelSelection = await setPiDefaultToFirstAvailableModel(provider);
  return NextResponse.json({ ...(await getPiModelsState()), modelSelection });
}

export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider")?.trim() || "";
  if (!provider) {
    return NextResponse.json({ error: "provider query param is required" }, { status: 400 });
  }
  const lock = await getEggentAiModelLockState();
  if (lock.locked) {
    if (lock.enforced) {
      return NextResponse.json({
        error: `Model selection is managed for this workspace. To use your own model or provider, run Eggent self-hosted: ${lock.selfHostedUrl}`,
        selfHostedUrl: lock.selfHostedUrl,
      }, { status: 403 });
    }
    if (provider !== "eggent-ai") {
      return NextResponse.json({ error: "Provider credentials are managed by Eggent AI for this workspace." }, { status: 403 });
    }
    await disableEggentAiModelLock();
    return NextResponse.json(await getPiModelsState());
  }

  const settings = await getPiSettingsState();
  try {
    await deletePiCredential(provider);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove the credential" },
      { status: 400 }
    );
  }
  // Removing the credential the workspace was answering on leaves it with no
  // model unless something else can take over. Say so rather than returning a
  // state that looks configured.
  const modelSelection = settings.defaultProvider === provider
    ? await setPiDefaultToFirstAvailableModel()
    : undefined;
  return NextResponse.json({ ...(await getPiModelsState()), ...(modelSelection ? { modelSelection } : {}) });
}
