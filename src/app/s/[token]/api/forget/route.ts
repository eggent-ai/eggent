import type { NextRequest } from "next/server";
import { forgetKey } from "@/lib/public-chat/visitors";
import { linkContext, NO_STORE, visitorCookieHeader, visitorCookieOf } from "@/lib/public-chat/route-helpers";

/** POST /s/<token>/api/forget: this browser stops writing as the visitor ("not you?"). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: true });
  if (context instanceof Response) return context;
  await forgetKey(context.token, visitorCookieOf(req));
  return Response.json({ ok: true }, { headers: { ...NO_STORE, "Set-Cookie": visitorCookieHeader(req, context.token, null) } });
}
