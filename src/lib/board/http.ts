import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { checkTerminalRequest, jsonError } from "@/lib/terminal/guard";
import { failureResponse } from "@/lib/terminal/respond";
import { BoardError } from "@/lib/board/cards";

/**
 * The board's routes check for themselves, like the terminal's: a card in the
 * queue is an agent with a shell started on the person's behalf, so a page on a
 * sibling workspace - same site, cookie included - must not be able to put one
 * there with a form it did not need a preflight for.
 */
export async function guardBoardRequest(req: NextRequest, write: boolean): Promise<Response | null> {
  const failure = await checkTerminalRequest(req, { write });
  return failure ? failureResponse(req, failure) : null;
}

export async function boardErrorResponse(req: NextRequest, error: unknown): Promise<Response> {
  if (error instanceof BoardError) {
    const t = await getServerTranslator(req.headers.get("accept-language"));
    return Response.json({ error: t(error.key, error.values), code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  console.error("[board] request failed:", error);
  return jsonError(error instanceof Error ? error.message : "The board could not do that.", 500);
}

export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}
