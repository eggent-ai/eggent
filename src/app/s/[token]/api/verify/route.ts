import type { NextRequest } from "next/server";
import { normalizeEmail, verifyVisitor } from "@/lib/public-chat/visitors";
import { clientAddress, fail, linkContext, NO_STORE, visitorCookieHeader, withinLimit } from "@/lib/public-chat/route-helpers";

/** POST /s/<token>/api/verify {email, code} -> {visitor}: the address is proved, and this browser writes as it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: true });
  if (context instanceof Response) return context;
  const { token } = context;
  const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!email || !/^\s*\d[\d\s-]{4,10}\d\s*$/.test(code)) return fail("Write the six digits from the letter.", 400, "badCode");
  if (!withinLimit("verify", `${token}:${clientAddress(req)}`, 30)) return fail("Too many tries. Try again in an hour.", 429, "rateLimited");
  const result = await verifyVisitor(token, { email, code });
  if (result.kind === "expired") return fail("This code is no longer valid. Ask for a new one.", 410, "codeExpired");
  if (result.kind === "wrong") return fail("The code is not right.", 400, result.attemptsLeft > 0 ? "codeWrong" : "codeExpired");
  return Response.json(
    { visitor: { name: result.visitor.name, email: result.visitor.email, confirmed: true } },
    { headers: { ...NO_STORE, "Set-Cookie": visitorCookieHeader(req, token, result.cookie) } }
  );
}
