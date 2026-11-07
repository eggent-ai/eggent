import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerLocale } from "@/i18n/server";
import { listBundledSkills } from "@/lib/storage/bundled-skills-store";
import { rememberFirstJob } from "@/lib/employees/onboarding";
import { FIRST_SHIFT_SKILL, reportWelcomeEvent, validWelcomeEvent } from "@/lib/employees/welcome";

/**
 * A step of the first question: {event, chatId?}. A chat the person started by
 * writing their own words is their first job, the same as one a button started,
 * so the plan offer finds it.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const body = (await req.json().catch(() => null)) as { event?: unknown; chatId?: unknown } | null;
  if (!validWelcomeEvent(body?.event)) return jsonError("Unknown event.", 400);
  if (typeof body?.chatId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.chatId)) {
    const locale = await getServerLocale(req.headers.get("accept-language"));
    const skill = (await listBundledSkills(locale)).find((item) => item.name === FIRST_SHIFT_SKILL);
    await rememberFirstJob(body.chatId, skill?.employee?.role ?? "").catch(() => {});
  }
  await reportWelcomeEvent(body.event);
  return Response.json({ ok: true });
}
