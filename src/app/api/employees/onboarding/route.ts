import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerLocale } from "@/i18n/server";
import { openOnboarding } from "@/lib/employees/onboarding";

/**
 * The employee the signup chose: its chat to open, started now if the
 * deployment did not start it already. 404 when there is none, 409 when it was
 * opened before.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const locale = await getServerLocale(req.headers.get("accept-language"));
  const opened = await openOnboarding(locale);
  if (!opened.ok) return jsonError(opened.error, opened.code);
  return Response.json({ projectId: opened.projectId, chatId: opened.chatId });
}
