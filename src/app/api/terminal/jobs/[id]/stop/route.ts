import { NextRequest } from "next/server";
import { authorizeJobRequest } from "@/lib/terminal/guard";
import { failureResponse } from "@/lib/terminal/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/terminal/jobs/:id/stop
 *
 * Stops the whole process group, not only the shell: `npm run dev` is a shell
 * script around a server, and ending the shell alone would leave the server
 * running with nobody holding it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await authorizeJobRequest(req, params, { write: true });
  if ("failure" in authorized) return failureResponse(req, authorized.failure);
  const { id, registry } = authorized.context;
  const stopped = registry.kill(id, "stopped");
  return Response.json({ ok: stopped }, { headers: { "Cache-Control": "no-store" } });
}
