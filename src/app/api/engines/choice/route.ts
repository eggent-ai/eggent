import { NextRequest, NextResponse } from "next/server";
import { applyEngineChoice, normalizeScope } from "@/lib/engines/service";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  project?: unknown;
  engine?: unknown;
  model?: unknown;
  access?: unknown;
  confirm?: unknown;
}

/**
 * PUT /api/engines/choice
 *
 * Sets which program a project runs on (`engine: null` puts it back on a
 * model). A program that has not been confirmed for this project yet is refused
 * with `consent-required` until the person has seen the first-use sheet and the
 * request says `confirm: true`. Written like the other settings that cost
 * something: a signed-in session of this site, and a JSON body a foreign page
 * cannot send without a preflight.
 */
export async function PUT(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") return jsonError("A JSON body is required.", 400);
  const engine = body.engine === null ? null : typeof body.engine === "string" && body.engine.trim() ? body.engine.trim() : undefined;
  if (engine === undefined) return jsonError("engine must name a program, or be null.", 400);

  const outcome = await applyEngineChoice(normalizeScope(body.project), {
    engine,
    model: body.model,
    access: body.access,
    confirm: body.confirm === true,
  });
  // The code is the answer; the screen says it in its own words.
  if (!outcome.ok) return NextResponse.json({ error: outcome.code }, { status: outcome.status });
  return NextResponse.json({ choice: outcome.choice });
}
