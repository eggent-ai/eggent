import { NextRequest, NextResponse } from "next/server";
import { probeEngine } from "@/lib/engines/service";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/engines/<id>/probe { model? }
 *
 * Asks the program for one word, in an empty folder, to find out that it
 * answers before a project is moved onto it. It uses a little of the person's
 * own subscription, so it is a write like the rest.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { model?: unknown };
  const result = await probeEngine(id, typeof body.model === "string" ? body.model.trim() : "");
  if (!result) return jsonError("No such program.", 404);
  return NextResponse.json({
    ok: result.ok,
    text: result.text.slice(0, 200),
    ...(result.error ? { error: result.error } : {}),
  });
}
