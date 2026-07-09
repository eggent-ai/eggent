import { NextRequest, NextResponse } from "next/server";
import { getPiAuthStorage, getPiModelsState } from "@/lib/pi/config-store";

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

  const authStorage = getPiAuthStorage();
  await authStorage.set(provider, env ? { type: "api_key", key: apiKey, env } : { type: "api_key", key: apiKey });
  return NextResponse.json(await getPiModelsState());
}

export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider")?.trim() || "";
  if (!provider) {
    return NextResponse.json({ error: "provider query param is required" }, { status: 400 });
  }
  const authStorage = getPiAuthStorage();
  await authStorage.remove(provider);
  return NextResponse.json(await getPiModelsState());
}
