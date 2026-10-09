import { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { authorizeJobRequest, jsonError } from "@/lib/terminal/guard";
import { failureResponse } from "@/lib/terminal/respond";
import { TERMINAL_LIMITS } from "@/lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/terminal/jobs/:id/input  { data } - keystrokes, or a line for a command that asked. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await authorizeJobRequest(req, params, { write: true });
  if ("failure" in authorized) return failureResponse(req, authorized.failure);
  const { id, registry } = authorized.context;

  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { data?: unknown } | null;
  const data = body?.data;
  if (typeof data !== "string" || data.length === 0 || data.length > TERMINAL_LIMITS.maxInputChars) {
    return jsonError(t("api.error.terminalInputInvalid"), 400);
  }
  const written = registry.write(id, data);
  return Response.json({ ok: written }, { status: written ? 200 : 409, headers: { "Cache-Control": "no-store" } });
}
