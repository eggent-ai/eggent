import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { firstJob } from "@/lib/employees/onboarding";

/**
 * What the deployment offers under the very first employee job of this
 * workspace (`?chatId=`), and nothing for any other chat. The offer itself -
 * whether there is one, its words, its link - is the deployment's
 * (EGGENT_EMPLOYEE_OFFER_URL); without one there is never an offer.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const url = process.env.EGGENT_EMPLOYEE_OFFER_URL?.trim();
  const token = process.env.EGGENT_SERVICES_TOKEN?.trim();
  const chatId = req.nextUrl.searchParams.get("chatId") || "";
  const first = await firstJob();
  if (!url || !token || !first || first.chatId !== chatId) return Response.json({ show: false });
  const target = new URL(url);
  target.searchParams.set("role", first.role);
  const answer = await fetch(target, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null) as { show?: boolean; title?: string; text?: string; button?: string; url?: string } | null;
  if (!answer?.show || typeof answer.url !== "string" || !/^https?:\/\//.test(answer.url)) return Response.json({ show: false });
  return Response.json(
    { show: true, title: String(answer.title || ""), text: String(answer.text || ""), button: String(answer.button || ""), url: answer.url },
    { headers: { "Cache-Control": "no-store" } }
  );
}
