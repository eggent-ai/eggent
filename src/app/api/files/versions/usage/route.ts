import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerTranslator } from "@/i18n/server";
import { getVersionStore } from "@/lib/files/versions/store";
import { versionUsage } from "@/lib/files/versions/view";

/**
 * How much the history of files takes, and clearing it:
 *
 *   GET  /api/files/versions/usage                                    ->  VersionUsageView
 *   POST /api/files/versions/usage  { action: "clear", olderThanDays? }  ->  VersionUsageView
 *
 * The history counts against the workspace's disk, so the person must be able to
 * see it and take it back - all of it, or what is older than a few days. The
 * newest version of every file is what the file holds and costs nothing to keep
 * beyond itself, so "older than" never removes it.
 */

export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  return Response.json(await versionUsage(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { action?: unknown; olderThanDays?: unknown } | null;
  if (body?.action !== "clear") return jsonError(t("files.history.clearFailed"), 400);
  const days = typeof body.olderThanDays === "number" && Number.isFinite(body.olderThanDays) && body.olderThanDays >= 0
    ? body.olderThanDays
    : undefined;
  await getVersionStore().clear(days === undefined ? {} : { olderThanDays: days });
  return Response.json(await versionUsage(), { headers: { "Cache-Control": "no-store" } });
}
