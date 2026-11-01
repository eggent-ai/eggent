import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerLocale } from "@/i18n/server";
import { takeOnboarding } from "@/lib/employees/onboarding";

/** Starts the employee the signup left waiting; answers 404 when there is none, 409 when it already started. */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const locale = await getServerLocale(req.headers.get("accept-language"));
  const taken = await takeOnboarding(locale);
  if (!taken.ok) return jsonError(taken.error, taken.code);
  return Response.json({ projectId: taken.result.projectId, chatId: taken.result.chatId, message: taken.result.message, role: taken.result.skill.employee?.role });
}
