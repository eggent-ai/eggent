import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";
import { getServerLocale } from "@/i18n/server";
import { readOnboarding, takeOnboarding } from "@/lib/employees/onboarding";

/**
 * The deployment starts the employee its signup chose the moment the
 * workspace is ready, so the first job is under way before the person's
 * browser arrives - and does not depend on the browser arriving at all. The
 * external API's token. 404 when nothing waits, 409 when it already started.
 */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function POST(req: NextRequest) {
  const [scheme, given] = (req.headers.get("authorization") || "").trim().split(/\s+/, 2);
  const stored = await getExternalApiToken();
  const fromEnv = process.env.EXTERNAL_API_TOKEN?.trim();
  if (scheme?.toLowerCase() !== "bearer" || !given || ![stored, fromEnv].some((token) => token && same(given, token))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const locale = await getServerLocale(req.headers.get("accept-language"));
  const taken = await takeOnboarding(locale);
  if (!taken.ok) {
    // Already started (by the dashboard, or a second call): which chat it is,
    // so the deployment can still send the person straight to it.
    const record = taken.code === 409 ? await readOnboarding().catch(() => null) : null;
    return Response.json({ error: taken.error, ...(record?.chatId ? { chatId: record.chatId, projectId: record.projectId } : {}) }, { status: taken.code });
  }
  return Response.json({ chatId: taken.result.chatId, projectId: taken.result.projectId });
}
