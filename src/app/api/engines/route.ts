import { NextRequest, NextResponse } from "next/server";
import { engineState, normalizeScope } from "@/lib/engines/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/engines?project=<id|none>[&fresh=1]
 *
 * The programs of this computer a project could run on, whether each is ready,
 * and what the project is set to. Empty (`available: false`) wherever nothing
 * registered an engine, which is how the cloud and a plain install stay as they
 * were. `fresh` skips the short memory of the last look at each program.
 */
export async function GET(req: NextRequest) {
  const project = normalizeScope(req.nextUrl.searchParams.get("project"));
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  return NextResponse.json(await engineState(project, { fresh }), { headers: { "cache-control": "no-store" } });
}
