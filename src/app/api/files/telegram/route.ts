import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerTranslator } from "@/i18n/server";
import { hasTelegramDestination } from "@/lib/telegram/outbound";
import { sendWorkspaceFileToTelegram } from "@/lib/files/telegram-send";

/**
 * GET  - whether this workspace can deliver to Telegram at all, so the button is offered only where it works.
 * POST - one file to the person's own chat: { project, path, chatId? }.
 *
 * A write that sends a workspace file somewhere takes the same guard as the
 * routes that start a shell: a session, this site, and a JSON body.
 */

export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  return Response.json({ available: await hasTelegramDestination() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { project?: unknown; path?: unknown; chatId?: unknown } | null;
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const relative = typeof body?.path === "string" ? body.path.trim() : "";
  if (!project || !relative) return jsonError(t("api.error.projectIdAndFilePathRequired"), 400);

  const outcome = await sendWorkspaceFileToTelegram({
    project,
    path: relative,
    chatId: typeof body?.chatId === "string" && body.chatId.trim() ? body.chatId.trim() : undefined,
  });
  if (outcome.ok) return Response.json({ success: true, name: outcome.name, sentAs: outcome.sentAs });
  if (outcome.reason === "not-found") return jsonError(t("api.error.fileNotFound"), 404);
  if (outcome.reason === "too-large") return jsonError(t("api.error.telegramFileTooLarge"), 413);
  if (outcome.reason === "no-destination") return jsonError(t("api.error.telegramNoDestination"), 409);
  return jsonError(outcome.error || t("api.error.telegramSendFailed"), 502);
}
