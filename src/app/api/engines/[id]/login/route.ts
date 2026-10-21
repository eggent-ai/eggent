import { NextRequest, NextResponse } from "next/server";
import { cancelEngineLogin, startEngineLogin } from "@/lib/engines/service";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/engines/<id>/login starts the program's own sign-in, which opens
 * the browser on this computer; DELETE gives it up. Nothing here sees what the
 * person types or any credential: the program does its sign-in itself, and the
 * screen only watches its status afterwards.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  const { id } = await context.params;
  try {
    const result = await startEngineLogin(id);
    if (result === "unknown") return jsonError("No such program.", 404);
    return NextResponse.json({ started: true, already: result === "running" });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not start signing in.", 500);
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  const { id } = await context.params;
  return NextResponse.json({ cancelled: cancelEngineLogin(id) });
}
