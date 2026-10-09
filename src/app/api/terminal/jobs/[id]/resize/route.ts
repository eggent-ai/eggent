import { NextRequest } from "next/server";
import { authorizeJobRequest } from "@/lib/terminal/guard";
import { failureResponse } from "@/lib/terminal/respond";
import { clampTerminalSize } from "@/lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/terminal/jobs/:id/resize  { cols, rows } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await authorizeJobRequest(req, params, { write: true });
  if ("failure" in authorized) return failureResponse(req, authorized.failure);
  const { id, registry } = authorized.context;

  const body = (await req.json().catch(() => null)) as { cols?: unknown; rows?: unknown } | null;
  const size = clampTerminalSize(body?.cols, body?.rows);
  const resized = registry.resize(id, size.cols, size.rows);
  return Response.json({ ok: resized, ...size }, { headers: { "Cache-Control": "no-store" } });
}
