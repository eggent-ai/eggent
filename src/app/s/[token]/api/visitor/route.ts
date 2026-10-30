import type { NextRequest } from "next/server";
import { sendVisitorCode, visitorMailAvailable } from "@/lib/public-chat/shares";
import { forgetCode, maskEmail, normalizeEmail, normalizeName, startVisitor } from "@/lib/public-chat/visitors";
import { clientAddress, fail, linkContext, NO_STORE, visitorCookieHeader, withinLimit } from "@/lib/public-chat/route-helpers";

/**
 * POST /s/<token>/api/visitor {name, email}
 *
 * An address seen for the first time: this browser writes as it from now on
 * ({visitor}). An address that has a visitor already: a code goes to it and
 * the page asks for the code ({needsCode, email}); see lib/public-chat/visitors.ts.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: true });
  if (context instanceof Response) return context;
  const { token } = context;
  const body = (await req.json().catch(() => null)) as { name?: unknown; email?: unknown } | null;
  const name = normalizeName(body?.name);
  const email = normalizeEmail(body?.email);
  if (!name) return fail("Write your name.", 400, "badName");
  if (!email) return fail("Write an email address like name@example.com.", 400, "badEmail");
  if (!withinLimit("start", `${token}:${clientAddress(req)}`, 20)) return fail("Too many tries. Try again in an hour.", 429, "rateLimited");
  const mail = visitorMailAvailable();
  const started = await startVisitor(token, { name, email, mail });
  if (started.kind === "full") return fail("This link has as many visitors as it may.", 503, "full");
  if (started.kind === "started") {
    return Response.json(
      { visitor: { name: started.visitor.name, email: started.visitor.email, confirmed: false } },
      { headers: { ...NO_STORE, "Set-Cookie": visitorCookieHeader(req, token, started.cookie) } }
    );
  }
  if (started.code) {
    const locale = (req.headers.get("accept-language") || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    const letter = await sendVisitorCode(token, { email: started.email, code: started.code, locale });
    if (!letter.sent) {
      await forgetCode(token, started.visitorId);
      return letter.reason === "limited"
        ? fail("Too many codes went to this address today. Try again tomorrow.", 429, "codeLimited")
        : fail("The code could not be sent. Try again in a minute.", 502, "codeFailed");
    }
  }
  return Response.json({ needsCode: true, email: maskEmail(started.email) }, { headers: NO_STORE });
}
