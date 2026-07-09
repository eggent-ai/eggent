import { NextRequest, NextResponse } from "next/server";
import { getPiModelsState } from "@/lib/pi/config-store";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider")?.trim();
  const state = await getPiModelsState();
  const source = state.availableModels.length > 0 ? state.availableModels : state.models;
  const models = source
    .filter((model) => !provider || model.provider === provider)
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
      available: "available" in model ? model.available : true,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    }));
  return NextResponse.json({ models, providers: state.providers });
}
